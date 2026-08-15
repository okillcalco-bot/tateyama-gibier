-- tests/db/staff_device_tokens.test.sql
-- 端末トークン認証とスタッフキー試行制限のDBテスト。巻き戻しのみ・非破壊・再実行可。
-- 期待と違えば raise exception。

do $$
declare tok text; h text; ok boolean; n int; r boolean; ev int;
begin
  -- ── 端末トークン: 有効/失効/期限/一括失効 ──
  tok := 'dt_' || encode(extensions.gen_random_bytes(16),'hex');
  h := encode(extensions.digest(tok,'sha256'),'hex');
  insert into staff_device_tokens(token_sha256, label, expires_at) values (h, 'smoke', now()+interval '30 days');

  if not staff_token_ok(tok) then raise exception '有効トークンが通らない'; end if;
  if staff_token_resolve(tok) is null then raise exception 'resolveがnull'; end if;
  perform _ind_require_staff(tok);                        -- 端末トークンで認証成立（例外なし）
  if staff_token_ok('garbage') then raise exception 'でたらめトークンが通った'; end if;

  -- dt_ 形式は失効時に生キーへフォールバックしない
  begin perform _ind_require_staff('dt_' || encode(extensions.gen_random_bytes(8),'hex')); raise exception '無効dt_が通った';
  exception when sqlstate '28000' then null; end;

  -- 自己失効 → 以後不可
  if not staff_device_revoke(tok) then raise exception '失効に失敗'; end if;
  if staff_token_ok(tok) then raise exception '失効後も通る'; end if;

  -- 一括失効
  insert into staff_device_tokens(token_sha256, label) values (encode(extensions.digest('t2','sha256'),'hex'),'s2');
  n := staff_devices_revoke_all();
  if n < 1 then raise exception '一括失効0件'; end if;
  if staff_token_ok('t2') then raise exception '一括失効後も通る'; end if;

  -- ── スタッフキー試行制限（5分10回） ──
  insert into auth_attempts(kind, ok, created_at) select 'staff_key', false, now() from generate_series(1,10);
  if staff_key_ok('any') <> false then raise exception 'staff_key rate limit効かず'; end if;

  -- ── 回復コード試行制限（15分5回）＋監査 ──
  insert into auth_attempts(kind, ok, created_at) select 'recovery', false, now() from generate_series(1,5);
  r := admin_rotate_staff_key('wrong','a-very-long-newkey-1234567');
  if r <> false then raise exception 'recovery rate limit効かず'; end if;
  select count(*) into ev from security_events where event='recovery_locked' and created_at > now() - interval '1 min';
  if ev < 1 then raise exception 'recovery_locked監査が残らない'; end if;

  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm='ROLLBACK_OK' then raise notice 'staff_device_tokens.test: ALL OK (rolled back)'; else raise; end if;
end $$;
