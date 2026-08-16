-- tests/db/round4_matrix.test.sql
-- Codex 4巡目 P1-4: 報告と一致する12観点のうち、DBで検証できる項目をまとめて確認する。
-- 巻き戻しのみ・非破壊・再実行可。psql または MCP execute_sql。
-- （11 svMakeSheetsのsurvey_downloaded_at / 12 写真アップロード拒否のクライアント側は E2E で確認）
--
-- 1 request_log.result に submission_token/device token/staff key が無い
-- 2 冪等再送で同じ有効 submission token を取得
-- 3 成功済みでも 無効/期限切れ/別scope の submission token では結果を返さない
-- 4 別個体の object_path を拒否
-- 5 submission token の scope 違いを拒否
-- 6 enrollment RPC の SECURITY DEFINER/search_path/PUBLIC不可
-- 7 enrollment_tokens への anon/authenticated 直接 SELECT/INSERT/UPDATE/DELETE 拒否
-- 9 キー変更で未使用招待の revoked_at が設定される（UPDATE意味論）
-- 10 理由なし relabel を拒否
-- 12 private化前は capture-photos への書込ポリシーが存在しない（サーバ側で拒否）

do $$
declare
  bad text; v_dt text; v_dtid uuid; r jsonb; r2 jsonb; iid uuid; stok text; stok2 text;
  v_prefix text; v_denied boolean; v_e1 uuid; v_e2 uuid; v_rev1 timestamptz; v_rev2 timestamptz;
  v_reqlog jsonb; v_col int; v_iid2 uuid;
begin
  -- 端末トークン
  v_dt := 'dt_' || encode(extensions.gen_random_bytes(16),'hex');
  insert into staff_device_tokens(token_sha256, expires_at) values (encode(extensions.digest(v_dt,'sha256'),'hex'), now()+interval '30 days') returning id into v_dtid;

  -- 公開登録（submission_token 発行）
  r  := public_capture_submit('{"species":"シカ","hunter_name":"matrix"}'::jsonb, 'matrixreq0001');
  iid := (r->>'id')::uuid; stok := r->>'submission_token';

  -- (1) request_log.result に token 類が無い
  select result into v_reqlog from request_log where fn='public_capture_submit' and client_request_id='matrixreq0001';
  if v_reqlog ? 'submission_token' then raise exception '(1) request_logにsubmission_token漏洩'; end if;
  if v_reqlog::text ~* '(st_|dt_|staff_key)' then raise exception '(1) request_logにcredential痕跡'; end if;
  -- submission_tokens は sha256 のみ（平文列なし）
  select count(*) into v_col from information_schema.columns
   where table_schema='public' and table_name='submission_tokens' and column_name in ('token','plaintext','raw_token');
  if v_col <> 0 then raise exception '(1) submission_tokensに平文列がある'; end if;

  -- (2) 冪等再送で同じ submission token
  r2 := public_capture_submit('{"species":"シカ","hunter_name":"matrix"}'::jsonb, 'matrixreq0001');
  if (r->>'id') <> (r2->>'id') then raise exception '(2) 再送で別個体'; end if;
  if coalesce(r2->>'submission_token','') <> stok then raise exception '(2) 再送でsubmission_token不一致'; end if;

  -- (3) 無効/期限切れ/別scope の submission token では結果を返さない
  begin perform public_capture_update_survey('st_invalid','{"submitter_name":"x"}'::jsonb,'matrixreq0002'); raise exception '(3) 無効tokenで更新できた';
  exception when others then if sqlerrm not like '%トークン%' then raise; end if; end;
  -- 期限切れ token を用意（同個体・scope正・期限過去）
  insert into submission_tokens(token_sha256, individual_id, scope, expires_at)
   values (encode(extensions.digest('st_expired','sha256'),'hex'), iid, 'survey_photo', now()-interval '1 minute');
  begin perform public_capture_update_survey('st_expired','{"submitter_name":"x"}'::jsonb,'matrixreq0003'); raise exception '(3) 期限切れtokenで更新できた';
  exception when others then if sqlerrm not like '%トークン%' then raise; end if; end;

  -- (5) scope 違いは拒否（scope='other' の有効tokenでも survey_photo 用RPCは通さない）
  insert into submission_tokens(token_sha256, individual_id, scope, expires_at)
   values (encode(extensions.digest('st_otherscope','sha256'),'hex'), iid, 'other', now()+interval '1 hour');
  begin perform public_capture_update_survey('st_otherscope','{"submitter_name":"x"}'::jsonb,'matrixreq0004'); raise exception '(5) scope違いtokenで更新できた';
  exception when others then if sqlerrm not like '%トークン%' then raise; end if; end;

  -- (4) 別個体の object_path を拒否（正しい token でも他個体プレフィックスは弾く）
  v_prefix := regexp_replace(coalesce((select label_id from individuals where id=iid),''), '[^A-Za-z0-9_-]', '_', 'g');
  -- 正: 自個体プレフィックスの object_path は通る
  r := public_attach_capture_photo(stok, null, v_prefix || '/ok.jpg', 'matrixreq0005');
  if (r->>'object_path') <> v_prefix || '/ok.jpg' then raise exception '(4) 正当なobject_pathが通らない'; end if;
  -- 誤: 別個体プレフィックス
  begin perform public_attach_capture_photo(stok, null, 'OTHERINDIV/x.jpg', 'matrixreq0006'); raise exception '(4) 別個体object_pathが通った';
  exception when others then if sqlerrm not like '%対象個体のもの%' then raise; end if; end;
  -- 誤: パストラバーサル
  begin perform public_attach_capture_photo(stok, null, v_prefix || '/../etc', 'matrixreq0007'); raise exception '(4) ../ が通った';
  exception when others then if sqlerrm not like '%不正%' and sqlerrm not like '%対象個体%' then raise; end if; end;

  -- (6) enrollment RPC の ACL
  select string_agg(proname, ',') into bad from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where n.nspname='public' and p.proname in ('staff_create_enrollment_token','staff_enroll_device')
     and (not prosecdef or proconfig::text not like '%search_path%' or has_function_privilege('public', p.oid,'EXECUTE'));
  if bad is not null then raise exception '(6) enrollment RPCのACL不備: %', bad; end if;
  -- staff_enroll_device は anon 実行可（端末が招待を交換する）
  if not has_function_privilege('anon', 'staff_enroll_device(text,text)', 'EXECUTE') then raise exception '(6) staff_enroll_deviceがanon不可'; end if;

  -- (7) enrollment_tokens への anon 直接 DML 拒否（RLS有効＋anonへ権限無し）
  if not (select relrowsecurity from pg_class where oid='public.enrollment_tokens'::regclass) then raise exception '(7) enrollment_tokens RLS無効'; end if;
  if has_table_privilege('anon','public.enrollment_tokens','INSERT') or has_table_privilege('anon','public.enrollment_tokens','UPDATE')
     or has_table_privilege('anon','public.enrollment_tokens','DELETE') or has_table_privilege('anon','public.enrollment_tokens','SELECT')
  then raise exception '(7) anonがenrollment_tokensへ直接DML/SELECT可能'; end if;

  -- (9) キー変更で未使用招待の revoked_at（admin_rotate内のUPDATE意味論）
  insert into enrollment_tokens(token_sha256, label, expires_at) values (encode(extensions.digest('et_u1','sha256'),'hex'),'u', now()+interval '10 min') returning id into v_e1;
  insert into enrollment_tokens(token_sha256, label, expires_at, used_at, device_token_id) values (encode(extensions.digest('et_u2','sha256'),'hex'),'used', now()+interval '10 min', now(), v_dtid) returning id into v_e2;
  update enrollment_tokens set revoked_at = now() where used_at is null and revoked_at is null;
  select revoked_at into v_rev1 from enrollment_tokens where id=v_e1;
  select revoked_at into v_rev2 from enrollment_tokens where id=v_e2;
  if v_rev1 is null then raise exception '(9) 未使用招待が失効しない'; end if;
  if v_rev2 is not null then raise exception '(9) 使用済み招待まで失効'; end if;

  -- (10) 理由なし relabel を拒否
  begin perform staff_individual_relabel(v_dt, iid, 'TGC-08-MTX1', null); raise exception '(10) 理由なしrelabelが通った';
  exception when others then if sqlerrm not like '%理由%' then raise; end if; end;
  -- 理由ありは通る
  r := staff_individual_relabel(v_dt, iid, 'TGC-08-MTX1', '誤記の訂正');
  if (r->>'relabeled')::boolean <> true then raise exception '(10) 理由ありrelabelが反映されない'; end if;

  -- (12) capture-photos への書込ポリシーが無い（private化前の停止）
  if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='capture_photos_all') then
    raise exception '(12) capture_photos_all(書込許可)が残っている'; end if;
  if not exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and policyname='capture_photos_read' and cmd='SELECT') then
    raise exception '(12) capture_photos_read(SELECT)が無い'; end if;
  if exists (select 1 from pg_policies where schemaname='storage' and tablename='objects' and cmd in ('INSERT','UPDATE','DELETE') and qual ~ 'capture-photos') then
    raise exception '(12) capture-photosへの書込ポリシーが存在する'; end if;

  raise notice 'ROUND4 MATRIX (DB) OK';
  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm='ROLLBACK_OK' then raise notice 'round4_matrix.test: ALL OK (rolled back)'; else raise; end if;
end $$;
