-- capture-photos private化＋grant方式の実DBテスト（migrations/20260816_capture_photos_private_grants.sql 対象）
--
-- 実行方法:
--   psql -v ON_ERROR_STOP=1 -f tests/db/capture_photos_private_grants.test.sql
--   （SQL Editor / API はファイル全体を貼って実行しエラー応答で判定）
--   ※ 事前に対象マイグレーションが適用されていること（individual_photos / photo_grants / 各RPCが存在）。
--
-- カバー範囲:
--   ・アップロードgrント発行（スタッフ認証・種別/MIME/サイズ検証・128bit乱数を含むサーバ選定path）
--   ・冪等（同一client_request_idは同じpath・行を増やさない）
--   ・grant検証関数（upload/read分離）
--   ・確定（storage実在確認→写真行作成→grant消費）・再確定の冪等
--   ・署名DL用read grント発行
--   ・一覧RPC
--   ・認可（anonはgrant表/写真表を直接読めない・RPCはEXECUTE可）
-- 全体を begin〜rollback で囲むため本番に残骸を残さない（storageへのダミー行も巻き戻る）。

begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare
  v_tok text := 'TESTTOK-'||md5(random()::text);
  v_ind uuid; r jsonb; r2 jsonb; v_path text; v_pid uuid; v_cnt int;
begin
  insert into staff_device_tokens(token_sha256,label,expires_at)
    values(encode(extensions.digest(v_tok,'sha256'),'hex'),'テスト端末',now()+interval '1 day');
  select id into v_ind from individuals where deleted_at is null limit 1;

  -- 1) アップロードgrント発行
  r := photo_request_upload(v_tok, v_ind, 'signboard', 'crid-1', 'image/jpeg', 500000);
  v_path := r->>'object_path';
  insert into _t values (1,'upload grant: path=label/種別/32hex.jpg', v_path ~ ('/signboard/[0-9a-f]{32}\.jpg$'), v_path);
  insert into _t values (2,'upload grant行が1件', (select count(*) from photo_grants where mode='upload' and client_request_id='crid-1')=1, '');

  -- 2) 冪等
  r2 := photo_request_upload(v_tok, v_ind, 'signboard', 'crid-1', 'image/jpeg', 500000);
  insert into _t values (3,'冪等: 同一crIdは同じpath・grant増えない',
    (r->>'object_path')=(r2->>'object_path') and (select count(*) from photo_grants where client_request_id='crid-1')=1, '');

  -- 3) grant検証関数
  insert into _t values (4,'grant_ok upload=true / read=false',
    capture_photo_grant_ok('capture-photos', v_path, 'upload') and not capture_photo_grant_ok('capture-photos', v_path, 'read'), '');

  -- 4) 認証・入力検証
  begin perform photo_request_upload('bad', v_ind,'signboard','x','image/jpeg',1); insert into _t values (5,'不正token拒否',false,'');
  exception when others then insert into _t values (5,'不正token拒否', sqlerrm like '%ログインし直して%',''); end;
  begin perform photo_request_upload(v_tok, v_ind,'signboard','y','image/gif',1000); insert into _t values (6,'不正MIME拒否',false,'');
  exception when others then insert into _t values (6,'不正MIME拒否', sqlerrm like '%画像形式%',''); end;
  begin perform photo_request_upload(v_tok, v_ind,'signboard','z','image/jpeg',9999999); insert into _t values (7,'サイズ超過拒否',false,'');
  exception when others then insert into _t values (7,'サイズ超過拒否', sqlerrm like '%サイズ%',''); end;
  begin perform photo_request_upload(v_tok, v_ind,'unknown_kind','w','image/jpeg',1000); insert into _t values (8,'不正種別拒否',false,'');
  exception when others then insert into _t values (8,'不正種別拒否', sqlerrm like '%写真種別%',''); end;

  -- 5) 確定（実体無し→拒否 / 実体あり→作成）
  begin perform photo_confirm_upload(v_tok,'crid-1'); insert into _t values (9,'実体無しconfirm拒否',false,'');
  exception when others then insert into _t values (9,'実体無しconfirm拒否', sqlerrm like '%確認できません%',''); end;

  insert into storage.objects(bucket_id,name,metadata)
    values('capture-photos', v_path, jsonb_build_object('size',500000,'mimetype','image/jpeg'));
  r := photo_confirm_upload(v_tok,'crid-1');
  insert into _t values (10,'confirmで写真行作成(duplicate=false)',
    (r->>'duplicate')::boolean=false and exists(select 1 from individual_photos where object_path=v_path and status='stored'), '');
  insert into _t values (11,'upload grant消費(used_at)',
    exists(select 1 from photo_grants where object_path=v_path and mode='upload' and used_at is not null), '');

  -- 6) 再確定は冪等
  r2 := photo_confirm_upload(v_tok,'crid-1');
  insert into _t values (12,'再confirm冪等(duplicate=true・行増えない)',
    (r2->>'duplicate')::boolean=true and (select count(*) from individual_photos where client_request_id='crid-1')=1, '');

  -- 7) 署名DL read grント
  select id into v_pid from individual_photos where object_path=v_path;
  r := photo_request_read(v_tok, v_pid);
  insert into _t values (13,'read grant発行(対象pathのみ・grant_ok read=true)',
    (r->>'object_path')=v_path and capture_photo_grant_ok('capture-photos', v_path, 'read'), '');

  -- 8) 一覧
  insert into _t values (14,'photo_list に確定写真が出る', exists(select 1 from photo_list(v_tok, v_ind) where id=v_pid), '');

  -- 9) 認可（anon直接テーブルアクセス不可・RPCはEXECUTE可）
  insert into _t values (15,'anonはindividual_photos/photo_grantsを直接SELECT不可',
    not has_table_privilege('anon','individual_photos','SELECT') and not has_table_privilege('anon','photo_grants','SELECT'), '');
  insert into _t values (16,'anonは写真RPCをEXECUTE可',
    has_function_privilege('anon','photo_request_upload(text,uuid,text,text,text,bigint)','EXECUTE')
    and has_function_privilege('anon','photo_confirm_upload(text,text)','EXECUTE')
    and has_function_privilege('anon','photo_request_read(text,uuid)','EXECUTE')
    and has_function_privilege('anon','capture_photo_grant_ok(text,text,text)','EXECUTE'), '');
end $$;

select * from _t order by no;

do $$
declare v_fails text; v_total int; v_ng int;
begin
  select count(*), count(*) filter (where not ok) into v_total, v_ng from _t;
  if v_ng > 0 then
    select string_agg(no||':'||item,' / ' order by no) into v_fails from _t where not ok;
    raise exception 'TEST FAILED (%/% 件): %', v_ng, v_total, v_fails;
  end if;
  raise notice 'ALL TESTS PASSED (% 件)', v_total;
end $$;

rollback;
