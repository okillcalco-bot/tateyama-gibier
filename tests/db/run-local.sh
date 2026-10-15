#!/usr/bin/env bash
# P0 migration と DBテストを、使い捨ての PostgreSQL で流す（本番DB・外部通信には一切触れない）。
#   1) 模擬土台 → migrations/20261015_p0*.sql を本番適用と同じ順に流し、適用後の権限を確かめる
#   2) 新しい模擬土台に tests/db/p0_security.test.sql を流し、"TESTRESULT: ALL PASS" を確かめる
#   3) 1) の後に rollback を逆順に流して、元に戻ることを確かめる
# 使い方: bash tests/db/run-local.sh   （PostgreSQL 14+ の initdb/pg_ctl が必要。PGBIN で場所を指定可）
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
PGBIN=${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}
[ -x "$PGBIN/initdb" ] || { echo "PostgreSQL(initdb)が見つかりません。PGBIN を指定してください"; exit 2; }
AS_PG=(); if [ "$(id -u)" = 0 ]; then AS_PG=(runuser -u postgres --); fi
TMP=$(mktemp -d); if [ "$(id -u)" = 0 ]; then chown postgres "$TMP"; fi
cleanup() { "${AS_PG[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"${AS_PG[@]}" "$PGBIN/initdb" -D "$TMP/data" -U postgres -A trust -E UTF8 --locale=C.UTF-8 >/dev/null
"${AS_PG[@]}" "$PGBIN/pg_ctl" -D "$TMP/data" -o "-k $TMP -c listen_addresses=''" -l "$TMP/server.log" -w start >/dev/null
export PGHOST="$TMP" PGUSER=postgres
fail=0
q() { psql -X -q -v ON_ERROR_STOP=1 -d "$1" "${@:2}"; }

echo "## 1) migration を適用順に流す"
q postgres -c 'create database mig' && q mig -f "$ROOT/tests/db/local_shim.sql" >/dev/null
for f in 20261015_p0a_staff_hunters_views_rpcs 20261015_p0b_staff_hunters_rls 20261015_p0_rpc_least_privilege \
         20261015_p0_write_least_privilege 20261015_p0_portal_password_purge; do
  q mig -f "$ROOT/migrations/$f.sql" >/dev/null 2>"$TMP/err" || { echo "NG $f"; cat "$TMP/err"; fail=1; }
  [ $fail = 0 ] && echo "ok $f"
done
check() { # $1=説明 $2=SQL(結果が t なら OK)
  local r; r=$(q mig -tA -c "$2" 2>&1 | tail -1)
  if [ "$r" = t ]; then echo "ok  $1"; else echo "NG  $1 → $r"; fail=1; fi
}
check "anon は staff 本体を読めない(0行)" "set role anon; select count(*)=0 from staff"
check "anon は hunters 本体を読めない(0行)" "set role anon; select count(*)=0 from hunters"
check "staff-key があれば staff 本体を読める" "set request.headers='{\"x-staff-key\":\"test-staff-key\"}'; set role anon; select count(*)=2 from staff"
check "staff_public は anon で読める" "set role anon; select count(*)=2 from staff_public"
check "hunters_public に name_public がある・phone は無い" "select exists(select 1 from information_schema.columns where table_name='hunters_public' and column_name='name_public') and not exists(select 1 from information_schema.columns where table_name='hunters_public' and column_name='phone')"
check "anon は *_impl を実行できない" "select bool_and(not has_function_privilege('anon', p.oid, 'EXECUTE')) from pg_proc p where proname like '%\_impl' escape '\\'"
check "ラッパーは staff-key 付きなら本体を呼ぶ" "set request.headers='{\"x-staff-key\":\"test-staff-key\"}'; set role anon; select (sale_event_settle('00000000-0000-0000-0000-000000000000'::uuid, null)->>'fn')='settle'"
check "anon は waste_summary を実行できない" "select not has_function_privilege('anon','public.waste_summary(date,date)','EXECUTE')"
check "anon は public_holidays に書けない" "select not has_table_privilege('anon','public.public_holidays','INSERT')"
check "portal_password は全件 NULL" "select count(*)=0 from customers where portal_password is not null"

echo "## 2) DBテスト（tests/db/p0_security.test.sql）"
q postgres -c 'create database t' && q t -f "$ROOT/tests/db/local_shim.sql" >/dev/null
out=$(q t -f "$ROOT/tests/db/p0_security.test.sql" 2>&1 || true)
res=$(echo "$out" | grep -o 'TESTRESULT: .*' | head -1)
echo "${res:-$out}"; [ "$res" = "TESTRESULT: ALL PASS" ] || fail=1

echo "## 3) rollback を逆順に流す"
for f in 20261015_p0_portal_password_purge 20261015_p0_write_least_privilege 20261015_p0_rpc_least_privilege \
         20261015_p0b_staff_hunters_rls 20261015_p0a_staff_hunters_views_rpcs; do
  q mig -f "$ROOT/migrations/rollback/${f}_rollback.sql" >/dev/null 2>"$TMP/err" && echo "ok rollback $f" || { echo "NG rollback $f"; cat "$TMP/err"; fail=1; }
done
check "rollback 後は anon が staff を読める" "set role anon; select count(*)=2 from staff"
check "rollback 後は sale_event_settle が元の本体" "set role anon; select (sale_event_settle('00000000-0000-0000-0000-000000000000'::uuid, null)->>'fn')='settle'"
check "rollback 後に *_impl は残っていない" "select count(*)=0 from pg_proc where proname like '%\_impl' escape '\\'"

[ $fail = 0 ] && echo "ALL OK" || { echo "FAILED"; exit 1; }
