-- tests/db/portal_password_reissue.test.sql
-- staff_issue_portal_passwords（仮パスワード再発行）の単体テスト。
-- 前提: 20260816_portal_password_reissue_fix.sql と 20260816_portal_temp_password_lifecycle.sql 適用済み。
-- 検証:
--   ・42702（customer_id ambiguous）が起きない
--   ・6桁の数字パスワードを返す（先頭0を許容＝6桁固定）
--   ・存在しない顧客IDが混ざると全体拒否（部分更新しない）
--   ・発行で must_change=true / temp_expires_at≈now+7d / 既存セッション失効
--   ・スタッフキー不正は例外
-- begin/rollback。テストキーは app_secrets を一時上書き。

begin;

update app_secrets set hash = extensions.crypt('TESTKEY', extensions.gen_salt('bf')) where key='staff_key';

insert into customers (id, code, name, portal_login_id, portal_enabled, is_active) values
 ('11111111-0000-0000-0000-000000000001','RA','再A','ra',true,true),
 ('11111111-0000-0000-0000-000000000002','RB','再B','rb',true,true);

create temp table _t(n int, name text, pass boolean, detail text) on commit drop;

do $$
declare
  rec record; v_cnt int; v_all6 boolean; v_mc boolean; v_exp timestamptz; v_err text;
  X uuid := '11111111-0000-0000-0000-000000000001';
  Y uuid := '11111111-0000-0000-0000-000000000002';
begin
  -- 既存の（変更専用でない）セッションを1本用意→再発行で消えることを確認
  insert into customer_secrets (customer_id, password_hash, must_change) values (X, extensions.crypt('old', extensions.gen_salt('bf')), false);
  insert into portal_sessions (token, customer_id, expires_at) values ('pretoken_X', X, now()+interval '30 days');

  -- 正常発行（42702が出ないこと自体がテスト）
  v_cnt := 0; v_all6 := true;
  for rec in select * from staff_issue_portal_passwords('TESTKEY', array[X,Y]::uuid[]) loop
    v_cnt := v_cnt + 1;
    if rec.password !~ '^[0-9]{6}$' then v_all6 := false; end if;
  end loop;
  insert into _t values (1,'issues numeric 6-digit pw for each target (no 42702)', v_cnt=2 and v_all6, format('count=%s all6=%s', v_cnt, v_all6));

  -- 発行後の状態: must_change=true, temp_expires_at≈+7d
  select must_change, temp_expires_at into v_mc, v_exp from customer_secrets where customer_id=X;
  insert into _t values (2,'after issue: must_change=true and temp_expires ~ +7d',
    v_mc=true and v_exp > now()+interval '6 days' and v_exp < now()+interval '8 days', format('mc=%s exp=%s', v_mc, v_exp));

  -- 既存セッション失効（P0-3）
  select count(*) into v_cnt from portal_sessions where customer_id=X;
  insert into _t values (3,'existing sessions revoked on reissue', v_cnt=0, format('sessions=%s', v_cnt));

  -- 存在しない顧客が混ざると全体拒否・部分更新なし
  begin
    perform staff_issue_portal_passwords('TESTKEY', array[X, '99999999-9999-9999-9999-999999999999']::uuid[]);
    insert into _t values (4,'nonexistent customer -> whole reject', false, 'no exception raised');
  exception when others then
    insert into _t values (4,'nonexistent customer -> whole reject', true, SQLERRM);
  end;

  -- スタッフキー不正は例外
  begin
    perform staff_issue_portal_passwords('WRONGKEY', array[X]::uuid[]);
    insert into _t values (5,'bad staff key -> exception', false, 'no exception');
  exception when others then
    insert into _t values (5,'bad staff key -> exception', true, 'raised');
  end;
end $$;

select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail from _t order by n;

do $$
declare v_fail int;
begin
  select count(*) into v_fail from _t where not pass;
  if v_fail > 0 then raise exception 'portal_password_reissue: % test(s) FAILED', v_fail; end if;
  raise notice 'portal_password_reissue: ALL PASS';
end $$;

rollback;
