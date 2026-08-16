-- 20260816_auth_rate_limit.sql
-- Codex 4巡目 P0-1: 認証(スタッフキー/回復コード/招待発行)の実レート制限。追加のみ。
--
-- 方針:
--  - 実際の試行回数制限を「原子的な固定窓カウンタ」で成立させる（成功/失敗に関係なく1試行=1加算）。
--    正しいキーでも窓内の試行上限を超えれば弾く＝ブルートフォースを制限できる。
--  - 制限ポリシー（窓・上限）はDBに一元化し、Edge Function からは scope+ip+device を渡すだけにする。
--  - これらの関数は anon/authenticated からは実行不可。Edge Function が service_role で呼ぶ。
--  - 監査データ(auth_attempts/security_events)と本カウンタの保持期限を定義（pg_cronで日次purge）。
--
-- 段階適用: 本ファイルは「追加のみ」で既存画面に影響しない（誰も未だ呼ばない）。
--   staff_key_ok/admin_rotate_staff_key/staff_create_enrollment_token の anon EXECUTE 剥奪は
--   別ファイル(20260816_revoke_anon_auth_rpcs.sql)で、Edge Function配置・全画面切替・回復経路確認後に適用する。

-- ── 固定窓カウンタ表（anonからは触れない。RLSでポリシー不在＝拒否） ──
create table if not exists auth_rate_buckets (
  bucket       text        not null,
  window_start timestamptz not null,
  count        int         not null default 0,
  primary key (bucket, window_start)
);
alter table auth_rate_buckets enable row level security;   -- 許可ポリシーを置かない＝anon/auth不可

-- ── 原子的インクリメント（ON CONFLICTで単一行を競合なく加算） ──
-- clock_timestamp() を使い、同一tx内の複数窓評価でも実時刻で判定する。
create or replace function _rl_hit(p_bucket text, p_window_secs int, p_limit int)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare v_start timestamptz; v_count int; v_now timestamptz := clock_timestamp();
begin
  if coalesce(p_window_secs,0) <= 0 or coalesce(p_limit,0) <= 0 then
    raise exception 'invalid rate limit params';
  end if;
  -- 固定窓の開始時刻 = floor(epoch/window)*window
  v_start := to_timestamp(floor(extract(epoch from v_now) / p_window_secs) * p_window_secs);
  insert into auth_rate_buckets(bucket, window_start, count)
    values (p_bucket, v_start, 1)
  on conflict (bucket, window_start) do update set count = auth_rate_buckets.count + 1
  returning count into v_count;
  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'limit', p_limit,
    'retry_after', greatest(0, ceil(extract(epoch from (v_start + make_interval(secs => p_window_secs)) - v_now)))::int
  );
end; $$;
revoke all on function _rl_hit(text, int, int) from public;
grant execute on function _rl_hit(text, int, int) to service_role;

-- ── ポリシー適用（scope別に複数窓を評価。IPと任意のdeviceの両軸で制限） ──
-- 戻り: {allowed: bool, retry_after: int}
create or replace function auth_rate_check(p_scope text, p_ip text, p_device text default null)
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_ip   text := coalesce(nullif(btrim(p_ip),''), 'unknown');
  v_dev  text := nullif(btrim(p_device),'');
  v_checks jsonb;
  v_win int; v_lim int; r jsonb; v_worst jsonb := null; i int;
begin
  -- scope別ポリシー: [[窓秒, 上限], ...]。短窓バースト＋長窓の二段。
  v_checks := case p_scope
    when 'staff_key' then '[[300,15],[3600,60]]'::jsonb     -- 5分15回 かつ 60分60回
    when 'recovery'  then '[[900,5],[86400,15]]'::jsonb      -- 15分5回 かつ 24時間15回
    when 'enroll'    then '[[3600,20],[86400,60]]'::jsonb    -- 60分20回 かつ 24時間60回
    else '[[300,20]]'::jsonb end;
  for i in 0 .. jsonb_array_length(v_checks)-1 loop
    v_win := (v_checks->i->>0)::int; v_lim := (v_checks->i->>1)::int;
    r := _rl_hit('ip:'||p_scope||':'||v_ip, v_win, v_lim);
    if not (r->>'allowed')::boolean then v_worst := r; end if;
    if v_dev is not null then
      r := _rl_hit('dev:'||p_scope||':'||v_dev, v_win, v_lim);
      if not (r->>'allowed')::boolean then v_worst := r; end if;
    end if;
  end loop;
  if v_worst is not null then
    insert into security_events(event, detail) values ('rate_limited', left(p_scope||' ip='||v_ip,120));
    return jsonb_build_object('allowed', false, 'retry_after', (v_worst->>'retry_after')::int);
  end if;
  return jsonb_build_object('allowed', true);
end; $$;
revoke all on function auth_rate_check(text, text, text) from public;
grant execute on function auth_rate_check(text, text, text) to service_role;

-- ── 保持期限（監査＋カウンタのpurge）。retention:
--    auth_attempts   : 180日   security_events : 365日   auth_rate_buckets : 2日 ──
create or replace function security_retention_purge()
returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare a int; e int; b int;
begin
  delete from auth_attempts     where created_at   < now() - interval '180 days'; get diagnostics a = row_count;
  delete from security_events   where created_at   < now() - interval '365 days'; get diagnostics e = row_count;
  delete from auth_rate_buckets where window_start < now() - interval '2 days';   get diagnostics b = row_count;
  return jsonb_build_object('auth_attempts_deleted',a,'security_events_deleted',e,'rate_buckets_deleted',b);
end; $$;
revoke all on function security_retention_purge() from public;
grant execute on function security_retention_purge() to service_role;

-- 日次スケジュール（pg_cron）。拡張が無い環境では手動/外部スケジューラで日次実行する。
do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    -- 既存の同名ジョブがあれば置き換え
    perform cron.unschedule(jobid) from cron.job where jobname = 'security_retention_daily';
    perform cron.schedule('security_retention_daily', '17 3 * * *', $q$select public.security_retention_purge();$q$);
  end if;
exception when others then
  -- cronが使えない場合もマイグレーション自体は成功させる（purge関数は手動実行可能）
  raise notice 'pg_cron schedule skipped: %', sqlerrm;
end $$;
