-- portal パスワード再発行の実DBテスト（migrations/20260816_portal_password_reissue_fix.sql 対象）
--
-- 実行方法:
--   psql -v ON_ERROR_STOP=1 -f tests/db/portal_password_reissue.test.sql
--   （SQL Editor / API はファイル全体を貼って実行しエラー応答で判定）
--   ※ 事前に対象マイグレーション適用済みであること。
--
-- カバー範囲（42702 曖昧エラー修正・暗号学的6桁・原子性）:
--   単独/一括発行・6桁数字・対象のみ変更・旧pw失効/新pwログイン・誤キー拒否・
--   存在しない顧客拒否（部分更新なし）・平文非保存。
-- 全体を begin〜rollback で囲み、専用テスト顧客のみ使用（本番顧客は変更しない）。

begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare v_key text := 'TESTKEY-'||md5(random()::text);
  c1 uuid; c2 uuid; c3 uuid; rr record; v_pw1 text; v_h_before text; v_h3_before text; n int;
begin
  update app_secrets set hash = extensions.crypt(v_key, extensions.gen_salt('bf')) where key='staff_key';
  insert into customers(code,name,price_rank,portal_login_id,portal_enabled,is_active) values('PWT-1','PW試験1','standard','pwt1',true,true) returning id into c1;
  insert into customers(code,name,price_rank,portal_login_id,portal_enabled,is_active) values('PWT-2','PW試験2','standard','pwt2',true,true) returning id into c2;
  insert into customers(code,name,price_rank,portal_login_id,portal_enabled,is_active) values('PWT-3','PW試験3(対照)','standard','pwt3',true,true) returning id into c3;
  insert into customer_secrets(customer_id,password_hash) values
    (c1, extensions.crypt('oldpw1', extensions.gen_salt('bf'))),
    (c2, extensions.crypt('oldpw2', extensions.gen_salt('bf'))),
    (c3, extensions.crypt('oldpw3', extensions.gen_salt('bf')));
  select password_hash into v_h_before from customer_secrets where customer_id=c1;
  select password_hash into v_h3_before from customer_secrets where customer_id=c3;

  select * into rr from staff_issue_portal_passwords(v_key, array[c1]) limit 1;
  v_pw1 := rr.password;
  insert into _t values(1,'単独再発行が6桁数字を返す', v_pw1 ~ '^[0-9]{6}$', v_pw1);
  insert into _t values(2,'対象c1のhashが変わる', (select password_hash from customer_secrets where customer_id=c1) <> v_h_before, '');
  insert into _t values(3,'対照c3のhashは不変', (select password_hash from customer_secrets where customer_id=c3) = v_h3_before, '');
  insert into _t values(4,'旧pwでportal_login不可', not exists(select 1 from portal_login('pwt1','oldpw1')), '');
  insert into _t values(5,'新pwでportal_login可', exists(select 1 from portal_login('pwt1', v_pw1)), '');

  select count(*) into n from staff_issue_portal_passwords(v_key, array[c1,c2]);
  insert into _t values(6,'一括で2件発行', n=2, n::text);
  insert into _t values(7,'一括の各pwも6桁', not exists(select 1 from staff_issue_portal_passwords(v_key, array[c1,c2]) where password !~ '^[0-9]{6}$'), '');

  begin perform staff_issue_portal_passwords('wrong', array[c1]); insert into _t values(8,'誤スタッフキー拒否',false,'');
  exception when others then insert into _t values(8,'誤スタッフキー拒否', sqlerrm like '%スタッフキー%',''); end;
  begin perform staff_issue_portal_passwords(v_key, array[gen_random_uuid()]); insert into _t values(9,'存在しない顧客は拒否',false,'');
  exception when others then insert into _t values(9,'存在しない顧客は拒否', sqlerrm like '%存在しない顧客%',''); end;
  begin perform staff_issue_portal_passwords(v_key, array[c1, gen_random_uuid()]); insert into _t values(10,'一部存在しないなら全体拒否(部分更新なし)',false,'');
  exception when others then insert into _t values(10,'一部存在しないなら全体拒否(部分更新なし)', sqlerrm like '%存在しない顧客%',''); end;

  insert into _t values(11,'customer_secretsに平文列が無い',
    not exists(select 1 from information_schema.columns where table_schema='public' and table_name='customer_secrets' and column_name not in ('customer_id','password_hash','updated_at')), '');
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
