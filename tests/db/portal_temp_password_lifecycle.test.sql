-- tests/db/portal_temp_password_lifecycle.test.sql
-- 仮パスワード方式＋顧客ロックアウト＋初回変更専用トークンのDBテスト（Codex必須15項目を網羅）。
-- 前提: 以下のマイグレーションが適用済みであること。
--   20260816_portal_password_reissue_fix.sql
--   20260816_portal_temp_password_lifecycle.sql
--   20260816_portal_session_require_password_set.sql
--   20260816_portal_revoke_legacy_auth.sql
-- 実行: begin/rollback で本番データに影響を残さない。テストキーは app_secrets を一時上書き（ロールバックで復元）。
-- 全アサーションは _t/_acl に記録し、末尾で1件でもFAILがあれば例外を投げる。

begin;

-- テスト用スタッフキー（rollbackで元に戻る）
update app_secrets set hash = extensions.crypt('TESTKEY', extensions.gen_salt('bf')) where key='staff_key';

insert into customers (id, code, name, portal_login_id, portal_enabled, is_active, phone, address, building) values
 ('11111111-1111-1111-1111-111111111111','ZZA','テストA','za',true,true ,'090-0000-0001','住A','建A'),
 ('22222222-2222-2222-2222-222222222222','ZZB','テストB','zb',true,true ,'090-0000-0002','住B','建B'),
 ('33333333-3333-3333-3333-333333333333','ZZC','テストC','zc',false,true ,'090-0000-0003','住C','建C'),
 ('44444444-4444-4444-4444-444444444444','ZZD','テストD','zd',true,false,'090-0000-0004','住D','建D'),
 ('55555555-5555-5555-5555-555555555555','ambigX','テストE','ambig',true,true,null,null,null),
 ('66666666-6666-6666-6666-666666666666','ambig','テストF','ambigY',true,true,null,null,null),
 ('77777777-7777-7777-7777-777777777777','ZZG','テストG','zg',true,true,null,null,null),
 ('88888888-8888-8888-8888-888888888888','ZZH','テストH','zh',true,true,null,null,null),
 ('99999999-9999-9999-9999-999999999999','ZZI','テストI','zi',true,true,null,null,null),
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','ZZJ','テストJ','zj',true,true,null,null,null);

insert into customer_secrets (customer_id, password_hash, must_change, temp_issued_at, temp_expires_at, failed_attempts) values
 ('11111111-1111-1111-1111-111111111111', extensions.crypt('123456', extensions.gen_salt('bf')), true, now(), now()+interval '7 days', 0),
 ('33333333-3333-3333-3333-333333333333', extensions.crypt('123456', extensions.gen_salt('bf')), true, now(), now()+interval '7 days', 0),
 ('44444444-4444-4444-4444-444444444444', extensions.crypt('123456', extensions.gen_salt('bf')), true, now(), now()+interval '7 days', 0),
 ('77777777-7777-7777-7777-777777777777', extensions.crypt('123456', extensions.gen_salt('bf')), true, now(), now()+interval '7 days', 0),
 ('88888888-8888-8888-8888-888888888888', extensions.crypt('123456', extensions.gen_salt('bf')), true, now(), now()-interval '1 day', 0),
 ('99999999-9999-9999-9999-999999999999', extensions.crypt('123456', extensions.gen_salt('bf')), true, now(), now()+interval '7 days', 0),
 ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', extensions.crypt('123456', extensions.gen_salt('bf')), true, now(), now()+interval '7 days', 0),
 ('22222222-2222-2222-2222-222222222222', extensions.crypt('RealPass99', extensions.gen_salt('bf')), false, null, null, 0);

create temp table _t(n int, name text, pass boolean, detail text) on commit drop;

do $$
declare
  rec record; rec2 record;
  v_ct text; v_cnt int; v_lu timestamptz; v_mc boolean; v_hash text; v_hb text; i int;
  A uuid := '11111111-1111-1111-1111-111111111111';
  B uuid := '22222222-2222-2222-2222-222222222222';
  G uuid := '77777777-7777-7777-7777-777777777777';
  CI uuid := '99999999-9999-9999-9999-999999999999';
begin
  -- (P1-1) must_change ログインは変更トークンのみ・PIIを返さない
  select * into rec from portal_login_v2('za','123456');
  insert into _t values (12,'no PII before change (must_change login)',
    rec.status='ok' and rec.must_change=true and rec.token is not null
    and rec.phone is null and rec.address is null and rec.code is null and rec.building is null,
    format('status=%s mc=%s phone=%s code=%s', rec.status, rec.must_change, rec.phone, rec.code));
  v_ct := rec.token;

  -- (P0-1系) 変更トークンは発行先顧客のみ変更。他顧客Bは不変
  select password_hash into v_hb from customer_secrets where customer_id=B;
  select * into rec from portal_complete_temp_password(v_ct, 'BrandNewPass1');
  select password_hash into v_hash from customer_secrets where customer_id=B;
  insert into _t values (7,'other customer (B) untouched by A token complete',
    rec.status='ok' and v_hash=v_hb, format('complete=%s Bchanged=%s', rec.status, v_hash<>v_hb));

  -- 変更後: must_change=false・セッションは新30日の1本のみ
  select must_change into v_mc from customer_secrets where customer_id=A;
  select count(*) into v_cnt from portal_sessions where customer_id=A;
  insert into _t values (30,'after complete: must_change=false + single 30d session',
    v_mc=false and v_cnt=1, format('mc=%s sessions=%s', v_mc, v_cnt));

  -- 使用済みトークンの再利用は不可（単一使用）
  select * into rec from portal_complete_temp_password(v_ct, 'AnotherPass22');
  insert into _t values (8,'used change token rejected', rec.status='invalid', format('status=%s', rec.status));

  -- 変更後の本pwで通常ログイン→PIIが返る
  select * into rec from portal_login_v2('za','BrandNewPass1');
  insert into _t values (31,'login with new pw: must_change=false + PII',
    rec.status='ok' and rec.must_change=false and rec.phone is not null, format('mc=%s phone=%s', rec.must_change, rec.phone));

  -- 通常pwセッションのトークンでは complete RPC を使えない
  select * into rec from portal_login_v2('zb','RealPass99');
  select * into rec2 from portal_complete_temp_password(rec.token, 'ShouldFail123');
  insert into _t values (3,'normal-pw token cannot use complete RPC', rec2.status='invalid', format('status=%s', rec2.status));

  -- portal_enabled=false / is_active=false は invalid（列挙防止）
  select * into rec from portal_login_v2('zc','123456');
  insert into _t values (4,'portal_enabled=false blocked (invalid)', rec.status='invalid', format('status=%s', rec.status));
  select * into rec from portal_login_v2('zd','123456');
  insert into _t values (5,'is_active=false blocked (invalid)', rec.status='invalid', format('status=%s', rec.status));

  -- (P1-4) 識別子が複数顧客に一致→invalid
  select * into rec from portal_login_v2('ambig','123456');
  insert into _t values (13,'ambiguous identifier -> invalid', rec.status='invalid', format('status=%s', rec.status));

  -- (P0-1) complete RPC はランダムトークン総当りを常に弾く
  for i in 1..6 loop
    select * into rec from portal_complete_temp_password('deadbeef'||i::text, 'GuessPass'||i::text);
  end loop;
  insert into _t values (1,'complete RPC brute-force blocked (random tokens invalid)', rec.status='invalid', format('status=%s', rec.status));

  -- 仮pw失効後は正しいpwでもログイン不可
  select * into rec from portal_login_v2('zh','123456');
  insert into _t values (2,'expired temp pw -> login invalid', rec.status='invalid', format('status=%s', rec.status));

  -- (P1-3) 5回失敗で locked_until がDBに設定される
  for i in 1..5 loop select * into rec from portal_login_v2('zg','999999'); end loop;
  select locked_until, failed_attempts into v_lu, v_cnt from customer_secrets where customer_id=G;
  insert into _t values (14,'5th failed login sets locked_until in DB',
    v_lu is not null and v_lu > now(), format('locked_until=%s fails=%s', v_lu, v_cnt));

  -- (P1-2) ロック中は正しい仮pwでも invalid・変更トークンを渡さない
  update customer_secrets set password_hash = extensions.crypt('123456', extensions.gen_salt('bf')) where customer_id=G;
  select * into rec from portal_login_v2('zg','123456');
  insert into _t values (6,'no change token while locked (correct pw -> invalid)',
    rec.status='invalid' and rec.token is null, format('status=%s token=%s', rec.status, rec.token));

  -- スタッフ解除→再ログインで変更トークンが得られる
  perform staff_unlock_portal('TESTKEY', G);
  select * into rec from portal_login_v2('zg','123456');
  insert into _t values (33,'staff_unlock restores login (ok + change token)',
    rec.status='ok' and rec.must_change=true and rec.token is not null, format('status=%s', rec.status));

  -- 変更トークンの期限切れ→complete は invalid
  select * into rec from portal_login_v2('zj','123456');
  update portal_sessions set expires_at = now()-interval '1 min'
   where token = encode(extensions.digest(rec.token,'sha256'),'hex');
  select * into rec2 from portal_complete_temp_password(rec.token, 'FreshPass123');
  insert into _t values (9,'expired change token rejected', rec2.status='invalid', format('status=%s', rec2.status));

  -- (P0-3) 再発行で対象顧客の全セッション失効＋must_change=true
  select * into rec from portal_login_v2('zi','123456');
  perform staff_issue_portal_passwords('TESTKEY', array[CI]::uuid[]);
  select count(*) into v_cnt from portal_sessions where customer_id=CI;
  select must_change into v_mc from customer_secrets where customer_id=CI;
  insert into _t values (10,'reissue kills sessions + resets must_change=true',
    v_cnt=0 and v_mc=true, format('sessions_after=%s mc=%s', v_cnt, v_mc));

  -- 新pwの強度チェック（トークン照合より前に評価）
  select * into rec from portal_complete_temp_password('x','short');
  insert into _t values (40,'weak new pw rejected', rec.status='weak', format('status=%s', rec.status));
  select * into rec from portal_complete_temp_password('x','password');
  insert into _t values (41,'common new pw rejected', rec.status='too_common', format('status=%s', rec.status));
  select * into rec from portal_complete_temp_password('x','aaaaaaaa');
  insert into _t values (42,'all-same-char new pw rejected', rec.status='too_common', format('status=%s', rec.status));
end $$;

-- same_as_temp: 有効長(8桁)の仮pwを流用しようとした場合に拒否（実運用の仮pwは6桁のため到達しないが分岐を検証）
do $$
declare rec record; M uuid := 'dddddddd-dddd-dddd-dddd-dddddddddddd'; v_tok text := 'rawtokenM_1234567890';
begin
  insert into customers (id, code, name, portal_login_id, portal_enabled, is_active)
    values (M,'ZZM','テストM','zm',true,true);
  insert into customer_secrets (customer_id, password_hash, must_change, temp_issued_at, temp_expires_at)
    values (M, extensions.crypt('TempAb34', extensions.gen_salt('bf')), true, now(), now()+interval '7 days');
  insert into portal_sessions (token, customer_id, expires_at)
    values (encode(extensions.digest(v_tok,'sha256'),'hex'), M, now()+interval '15 min');
  select * into rec from portal_complete_temp_password(v_tok, 'TempAb34');
  insert into _t values (43,'new pw == temp pw rejected (same_as_temp branch)', rec.status='same_as_temp', format('status=%s', rec.status));
end $$;

-- complete時に portal_enabled=false へ変わっていたら拒否
do $$
declare rec record; L uuid := 'cccccccc-cccc-cccc-cccc-cccccccccccc'; v_tok text := 'rawtokenL_1234567890';
begin
  insert into customers (id, code, name, portal_login_id, portal_enabled, is_active)
    values (L,'ZZL','テストL','zl',true,true);
  insert into customer_secrets (customer_id, password_hash, must_change, temp_issued_at, temp_expires_at)
    values (L, extensions.crypt('222333', extensions.gen_salt('bf')), true, now(), now()+interval '7 days');
  insert into portal_sessions (token, customer_id, expires_at)
    values (encode(extensions.digest(v_tok,'sha256'),'hex'), L, now()+interval '15 min');
  update customers set portal_enabled=false where id=L;
  select * into rec from portal_complete_temp_password(v_tok, 'GoodPass123');
  insert into _t values (44,'complete blocked when portal_enabled=false', rec.status='invalid', format('status=%s', rec.status));
end $$;

-- 多層防御: 変更トークンでは portal_session_customer が顧客を返さない（データ系RPC不可）
do $$
declare N uuid := 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; v_tok text; rec record; v_id uuid;
begin
  insert into customers (id, code, name, portal_login_id, portal_enabled, is_active)
    values (N,'ZZN','テストN','zn',true,true);
  insert into customer_secrets (customer_id, password_hash, must_change, temp_issued_at, temp_expires_at)
    values (N, extensions.crypt('345678', extensions.gen_salt('bf')), true, now(), now()+interval '7 days');
  select * into rec from portal_login_v2('zn','345678');
  v_tok := rec.token;
  v_id := portal_session_customer(v_tok);
  insert into _t values (50,'portal_session_customer returns NULL for change-only token',
    v_id is null, format('resolved=%s', v_id));
end $$;

-- ACL（P0-2）: 旧RPCは anon/authenticated から不可、新RPCは可
create temp table _acl(n int, name text, pass boolean, detail text) on commit drop;
do $$
begin
  insert into _acl values (200,'portal_login revoked from anon',
    not has_function_privilege('anon','public.portal_login(text,text)','execute'), 'anon');
  insert into _acl values (201,'portal_login revoked from authenticated',
    not has_function_privilege('authenticated','public.portal_login(text,text)','execute'), 'auth');
  insert into _acl values (202,'portal_change_password revoked from anon',
    not has_function_privilege('anon','public.portal_change_password(text,text,text)','execute'), 'anon');
  insert into _acl values (203,'portal_change_password revoked from authenticated',
    not has_function_privilege('authenticated','public.portal_change_password(text,text,text)','execute'), 'auth');
  insert into _acl values (204,'portal_complete_temp_password anon-executable',
    has_function_privilege('anon','public.portal_complete_temp_password(text,text)','execute'), 'anon');
  insert into _acl values (205,'portal_login_v2 anon-executable',
    has_function_privilege('anon','public.portal_login_v2(text,text,text)','execute'), 'anon');
  insert into _acl values (206,'legacy portal_login still callable by service_role',
    has_function_privilege('service_role','public.portal_login(text,text)','execute'), 'service');
end $$;

-- 結果表示
select n, case when pass then 'PASS' else 'FAIL' end as result, name, detail
from (select * from _t union all select * from _acl) u order by n;

-- 1件でもFAILがあれば例外（CIで検知）
do $$
declare v_fail int;
begin
  select count(*) into v_fail from (select pass from _t union all select pass from _acl) u where not pass;
  if v_fail > 0 then raise exception 'portal_temp_password_lifecycle: % test(s) FAILED', v_fail; end if;
  raise notice 'portal_temp_password_lifecycle: ALL PASS';
end $$;

rollback;
