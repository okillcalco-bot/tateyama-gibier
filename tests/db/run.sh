#!/usr/bin/env bash
# 手元に使い捨ての PostgreSQL を立て、土台（stub-schema.sql）→ 追加マイグレーション → テストSQL の順に流す。
#   bash tests/db/run.sh tests/db/recon.test.sql
# 本番DBには一切つながない。終わったらクラスタごと消す。テストSQLは最後に「N/M passed」を出す。
set -euo pipefail
cd "$(dirname "$0")/../.."
BIN=${PG_BIN:-/usr/lib/postgresql/16/bin}
TEST=${1:-tests/db/recon.test.sql}
DIR=$(mktemp -d /tmp/tg-pg-XXXXXX); PORT=${PG_PORT:-55432}
chown postgres "$DIR" 2>/dev/null || true
as_pg() { if [ "$(id -u)" = 0 ]; then su postgres -s /bin/bash -c "$*"; else bash -c "$*"; fi; }
cleanup() { as_pg "$BIN/pg_ctl -D $DIR/data -m immediate stop" >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
as_pg "$BIN/initdb -D $DIR/data -A trust -U postgres --no-sync" >/dev/null
as_pg "$BIN/pg_ctl -D $DIR/data -o '-p $PORT -k $DIR -c listen_addresses=' -l $DIR/log start -w" >/dev/null
PSQL="psql -h $DIR -p $PORT -U postgres -d postgres -v ON_ERROR_STOP=1 -q -X"
$PSQL -f tests/db/stub-schema.sql >/dev/null
$PSQL -f migrations/20261021_bank_reconciliation.sql >/dev/null
$PSQL -f migrations/20261021_bank_reconciliation.sql >/dev/null   # 2回流しても壊れない（追加のみ・冪等）
$PSQL -t -A -f "$TEST"
