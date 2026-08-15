-- tests/db/enrollment_tokens.test.sql
-- 使い捨て端末招待(enrollment token)のDBテスト。巻き戻しのみ・非破壊・再実行可。
-- 交換=単一tx・1回限り・期限/使用済み/無効の拒否・使用済み化と端末トークン発行の原子性・
-- 個体RPCはdt_のみ受理、を検証。
-- 注: 真の同時交換(2セッション)は tests/db/concurrent-* / CI で確認。ここは SELECT FOR UPDATE の
--     単一使用(used_at)ゲートを検証する。

do $$
declare et text; r jsonb; dtok text; used timestamptz; dtid uuid; etx text;
begin
  -- 有効な招待を直接用意して交換
  et := 'et_' || encode(extensions.gen_random_bytes(16),'hex');
  insert into enrollment_tokens(token_sha256, label, issuer, expires_at)
   values (encode(extensions.digest(et,'sha256'),'hex'), 'capture-form', 'staff', now()+interval '10 min');
  r := staff_enroll_device(et, 'capture-form');
  dtok := r->>'token';
  if dtok not like 'dt\_%' then raise exception 'dt_未発行'; end if;
  if not staff_token_ok(dtok) then raise exception '発行dt_が無効'; end if;
  -- 使用済み化と端末記録が同一txで反映
  select used_at, device_token_id into used, dtid from enrollment_tokens where token_sha256=encode(extensions.digest(et,'sha256'),'hex');
  if used is null or dtid is null then raise exception '使用済み化/端末記録がされていない'; end if;

  -- 1回限り（再利用は拒否）
  begin perform staff_enroll_device(et, 'x'); raise exception '再利用できた';
  exception when others then if sqlerrm not like '%使用済み%' then raise; end if; end;

  -- 期限切れは拒否
  etx := 'et_' || encode(extensions.gen_random_bytes(16),'hex');
  insert into enrollment_tokens(token_sha256, expires_at) values (encode(extensions.digest(etx,'sha256'),'hex'), now()-interval '1 min');
  begin perform staff_enroll_device(etx, 'x'); raise exception '期限切れで交換できた';
  exception when others then if sqlerrm not like '%期限%' then raise; end if; end;

  -- 失効済みは拒否
  etx := 'et_' || encode(extensions.gen_random_bytes(16),'hex');
  insert into enrollment_tokens(token_sha256, expires_at, revoked_at) values (encode(extensions.digest(etx,'sha256'),'hex'), now()+interval '10 min', now());
  begin perform staff_enroll_device(etx, 'x'); raise exception '失効済みで交換できた';
  exception when others then if sqlerrm not like '%失効%' then raise; end if; end;

  -- 無効な招待は拒否
  begin perform staff_enroll_device('et_bogus', 'x'); raise exception '無効招待が通った';
  exception when others then if sqlerrm not like '%無効%' then raise; end if; end;

  -- 個体RPCは dt_ のみ受理（生キー相当/でたらめは拒否）
  perform _ind_require_staff(dtok);
  begin perform _ind_require_staff('some-raw-staff-key'); raise exception '生キーが個体RPCで通った';
  exception when others then if sqlstate<>'28000' then raise; end if; end;

  -- staff_device_register（生キーでの端末登録）は廃止済み
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='staff_device_register') then
    raise exception 'staff_device_register が残っている（生キー登録経路）'; end if;

  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm='ROLLBACK_OK' then raise notice 'enrollment_tokens.test: ALL OK (rolled back)'; else raise; end if;
end $$;
