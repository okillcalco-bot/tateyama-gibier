#!/bin/bash
# 試験用の使い捨て PostgreSQL 16 を 127.0.0.1:55432 で起動する（本番には接続しない）
set -e
P=${SEAMALT_PG_DIR:-/var/tmp/seamalt-pg}
BIN=/usr/lib/postgresql/16/bin
mkdir -p "$P" && chown postgres "$P"
[ -d "$P/data" ] || su postgres -c "$BIN/initdb -D $P/data -A trust -U postgres >/dev/null"
su postgres -c "$BIN/pg_ctl -D $P/data -o '-p 55432 -k $P -c listen_addresses=127.0.0.1' -l $P/log status >/dev/null" \
  || su postgres -c "$BIN/pg_ctl -D $P/data -o '-p 55432 -k $P -c listen_addresses=127.0.0.1' -l $P/log -w start"
