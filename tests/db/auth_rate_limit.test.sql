-- tests/db/auth_rate_limit.test.sql
-- Codex 4巡目 P0-1: 認証レート制限＋認証RPCのanon剥奪の検証。巻き戻しのみ・非破壊・再実行可。
-- ・_rl_hit: 固定窓の許可/超過/窓経過での回復・原子的加算
-- ・auth_rate_check: scope別ポリシー・上限超過でretry_after・別IPは独立
-- ・剥奪(20260816_revoke_anon_auth_rpcs.sql相当)適用時、anonは認証RPCを直接実行できず、
--   service_roleのみ実行可（＝auth-gate経由に限定される）

do $$
declare
  r jsonb; a jsonb; v_bucket text := 'test:rl:'||gen_random_uuid()::text; v_ip text;
  i int; v_ok int := 0; v_blk int := 0; v_denied boolean;
begin
  -- ── _rl_hit: 窓1秒・上限3。1..3許可・4,5拒否 ──
  for i in 1..5 loop
    r := _rl_hit(v_bucket, 1, 3);
    if (r->>'allowed')::boolean then v_ok := v_ok+1; else v_blk := v_blk+1; end if;
  end loop;
  if v_ok<>3 or v_blk<>2 then raise exception '_rl_hit 許可/拒否数が不正: ok=% blk=%', v_ok, v_blk; end if;
  -- 窓経過で回復
  perform pg_sleep(1.2);
  r := _rl_hit(v_bucket, 1, 3);
  if not (r->>'allowed')::boolean then raise exception '_rl_hit 窓経過後に回復しない'; end if;
  -- 不正パラメータは例外
  begin perform _rl_hit('x', 0, 3); raise exception 'window=0が通った';
  exception when others then if sqlerrm like '%通った%' then raise; end if; end;

  -- ── auth_rate_check: staff_key=5分15回。15許可・16拒否・retry_after>0 ──
  v_ip := 'test-ip-'||gen_random_uuid()::text;
  for i in 1..15 loop
    a := auth_rate_check('staff_key', v_ip, null);
    if not (a->>'allowed')::boolean then raise exception 'staff_key 15回以内で拒否 (i=%)', i; end if;
  end loop;
  a := auth_rate_check('staff_key', v_ip, null);
  if (a->>'allowed')::boolean then raise exception 'staff_key 16回目が通った'; end if;
  if coalesce((a->>'retry_after')::int,0) <= 0 then raise exception 'retry_after が無い'; end if;
  -- 別IPは独立
  a := auth_rate_check('staff_key', 'other-'||gen_random_uuid()::text, null);
  if not (a->>'allowed')::boolean then raise exception '別IPが巻き込まれた'; end if;
  -- recovery scope は 15分5回（厳しめ）
  v_ip := 'test-ip-'||gen_random_uuid()::text;
  for i in 1..5 loop
    a := auth_rate_check('recovery', v_ip, null);
    if not (a->>'allowed')::boolean then raise exception 'recovery 5回以内で拒否 (i=%)', i; end if;
  end loop;
  a := auth_rate_check('recovery', v_ip, null);
  if (a->>'allowed')::boolean then raise exception 'recovery 6回目が通った'; end if;

  -- ── 認証RPCの anon 剥奪（ロールバックで戻る） ──
  execute 'revoke execute on function staff_key_ok(text) from anon, authenticated';
  execute 'revoke execute on function admin_rotate_staff_key(text, text) from anon, authenticated';
  execute 'revoke execute on function staff_create_enrollment_token(text, text) from anon, authenticated';
  execute 'grant execute on function staff_key_ok(text) to service_role';

  v_denied := false;
  begin
    set local role anon; perform staff_key_ok('dummy'); reset role;
  exception when insufficient_privilege then v_denied := true; reset role;
  when others then reset role; raise; end;
  if not v_denied then raise exception '剥奪後もanonがstaff_key_okを実行できた'; end if;

  v_denied := false;
  begin
    set local role anon; perform staff_create_enrollment_token('dummy','x'); reset role;
  exception when insufficient_privilege then v_denied := true; reset role;
  when others then reset role; raise; end;
  if not v_denied then raise exception '剥奪後もanonがstaff_create_enrollment_tokenを実行できた'; end if;

  -- service_role は実行可能（認証境界=auth-gate はこのロールで呼ぶ）
  begin
    set local role service_role; perform staff_key_ok('dummy'); reset role;
  exception when insufficient_privilege then reset role; raise exception 'service_roleがstaff_key_okを実行できない'; end;

  raise exception 'ROLLBACK_OK';
exception when others then
  if sqlerrm='ROLLBACK_OK' then raise notice 'auth_rate_limit.test: ALL OK (rolled back)'; else raise; end if;
end $$;
