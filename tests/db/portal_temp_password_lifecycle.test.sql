-- 仮パスワード方式＋顧客ロックの実DBテスト（migrations/20260816_portal_temp_password_lifecycle.sql 対象）
--
-- 実行方法:
--   psql -v ON_ERROR_STOP=1 -f tests/db/portal_temp_password_lifecycle.test.sql
--   （SQL Editor / API はファイル全体を貼って実行しエラー応答で判定）
--   ※ 事前に対象マイグレーション適用済みであること。
--
-- カバー範囲:
--   仮パスワード発行(6桁・must_change・7日失効)／仮pwログインok+must_change／本pw変更(status/token)／
--   変更後must_change=false・password_changed_at／新pwログイン／旧仮pw失効／変更ポリシー(weak/same_as_temp/
--   too_common)／5回失敗ロック・正しくてもlocked・他顧客非ロック・解除／共通invalid(不存在・停止)／
--   期限切れ仮pw／名簿状態(unissued/temp_issued/changed/temp_expired/locked)。
-- begin〜rollback・専用テスト顧客のみ（本番顧客は変更しない）。

begin;
create temp table _t(no int, item text, ok boolean, detail text) on commit drop;
do $$
declare v_key text := 'TK-'||md5(random()::text);
  c1 uuid; c2 uuid; cdis uuid; cu uuid; ce uuid; rr record; ch record; v_temp text; i int;
begin
  update app_secrets set hash=extensions.crypt(v_key,extensions.gen_salt('bf')) where key='staff_key';
  insert into customers(code,name,price_rank,portal_login_id,portal_enabled,is_active) values('TL-1','ロ1','standard','tl1',true,true) returning id into c1;
  insert into customers(code,name,price_rank,portal_login_id,portal_enabled,is_active) values('TL-2','ロ2','standard','tl2',true,true) returning id into c2;
  insert into customers(code,name,price_rank,portal_login_id,portal_enabled,is_active) values('TL-D','停','standard','tld',false,true) returning id into cdis;
  insert into customers(code,name,portal_enabled,portal_login_id,is_active) values('TL-U','未',true,'tlu',true) returning id into cu;
  insert into customers(code,name,portal_enabled,portal_login_id,is_active) values('TL-E','期',true,'tle',true) returning id into ce;
  insert into customer_secrets(customer_id,password_hash) values (cdis, extensions.crypt('x', extensions.gen_salt('bf')));
  insert into customer_secrets(customer_id,password_hash,must_change,temp_issued_at,temp_expires_at) values (ce, 'h', true, now()-interval '8 days', now()-interval '1 day');

  select * into rr from staff_issue_portal_passwords(v_key,array[c1]) limit 1; v_temp:=rr.password;
  insert into _t values(1,'発行:6桁・must_change・7日失効', v_temp ~ '^[0-9]{6}$' and (select must_change and temp_expires_at>now()+interval '6 days' from customer_secrets where customer_id=c1),'');
  select * into rr from portal_login_v2('tl1',v_temp,'ua') limit 1;
  insert into _t values(2,'仮pwログイン ok・must_change=true', rr.status='ok' and rr.must_change=true,'');
  select * into ch from portal_change_password('tl1',v_temp,'mynewpass1') limit 1;
  insert into _t values(3,'本pw変更 ok・token返す', ch.status='ok' and ch.token is not null,'');
  insert into _t values(4,'変更後 must_change=false・changed_at記録', (select not must_change and password_changed_at is not null from customer_secrets where customer_id=c1),'');
  select * into rr from portal_login_v2('tl1','mynewpass1','ua') limit 1;
  insert into _t values(5,'新pwログイン ok・must_change=false', rr.status='ok' and rr.must_change=false,'');
  select * into rr from portal_login_v2('tl1',v_temp,'ua') limit 1;
  insert into _t values(6,'旧仮pwは不可(invalid)', rr.status='invalid','');
  insert into _t values(7,'8文字未満 weak', (select status from portal_change_password('tl1','mynewpass1','short1') limit 1)='weak','');
  insert into _t values(8,'仮pwと同一 same_as_temp', (select status from portal_change_password('tl1','mynewpass1','mynewpass1') limit 1)='same_as_temp','');
  insert into _t values(9,'よくある値 too_common', (select status from portal_change_password('tl1','mynewpass1','password') limit 1)='too_common','');
  insert into _t values(10,'同一文字連続 too_common', (select status from portal_change_password('tl1','mynewpass1','00000000') limit 1)='too_common','');

  perform staff_issue_portal_passwords(v_key,array[c2]);
  for i in 1..5 loop perform portal_login_v2('tl2','wrongpw','ua'); end loop;
  select * into rr from portal_login_v2('tl2','wrongpw','ua') limit 1;
  insert into _t values(11,'5回失敗でlocked+解除時刻', rr.status='locked' and rr.locked_until>now(),'');
  select * into rr from portal_login_v2('tl2','anything','ua') limit 1;
  insert into _t values(12,'ロック中は正しくてもlocked', rr.status='locked','');
  insert into _t values(13,'他顧客c1は非ロック', (select coalesce(locked_until,'-infinity'::timestamptz)<now() from customer_secrets where customer_id=c1),'');
  perform staff_unlock_portal(v_key,c2);
  insert into _t values(14,'解除でlocked/failカウントクリア', (select locked_until is null and failed_attempts=0 from customer_secrets where customer_id=c2),'');
  insert into _t values(15,'存在しないID invalid(共通)', (select status from portal_login_v2('nope','x','ua') limit 1)='invalid','');
  insert into _t values(16,'portal_enabled=false invalid(共通)', (select status from portal_login_v2('tld','x','ua') limit 1)='invalid','');
  select * into rr from staff_issue_portal_passwords(v_key,array[c1]) limit 1; v_temp:=rr.password;
  update customer_secrets set temp_expires_at=now()-interval '1 day' where customer_id=c1;
  insert into _t values(17,'期限切れ仮pw invalid', (select status from portal_login_v2('tl1',v_temp,'ua') limit 1)='invalid','');

  -- 名簿状態
  insert into _t values(18,'名簿:未発行 unissued', (select pw_state from admin_portal_credential_status(v_key) where customer_id=cu)='unissued','');
  insert into _t values(19,'名簿:仮発行済 temp_issued', (select pw_state from admin_portal_credential_status(v_key) where customer_id=c2)='temp_issued','');
  insert into _t values(20,'名簿:期限切れ temp_expired', (select pw_state from admin_portal_credential_status(v_key) where customer_id=ce)='temp_expired','');
  begin perform admin_portal_credential_status('wrong'); insert into _t values(21,'名簿:誤キー拒否',false,'');
  exception when others then insert into _t values(21,'名簿:誤キー拒否', sqlerrm like '%スタッフキー%',''); end;
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
