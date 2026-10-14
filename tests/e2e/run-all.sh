#!/usr/bin/env bash
# tests/e2e を全部流して、ファイルごとの結果を一覧にする（手元・サンドボックス用）。
#   bash tests/e2e/run-all.sh            # 全部
#   bash tests/e2e/run-all.sh label      # 名前に label を含むものだけ
# OFFLINE=1 のときは、外へ出られないネットワーク（unshare -n、ループバックだけ有効）で流す。
#   テストは全部 page.route でモックしているので、外に出る必要はない。本番DBに触らないことを仕組みで保証したい時に使う
#   （root か unshare が使える環境のみ）。
set -u
cd "$(dirname "$0")/../.."
CHROME=${CHROME:-/opt/pw-browsers/chromium-1194/chrome-linux/chrome}
NODE=${NODE:-/opt/node22/bin/node}
export CHROME NODE_PATH=${NODE_PATH:-/opt/node22/lib/node_modules}
OUT=${OUT:-/tmp/tg-e2e-results}; mkdir -p "$OUT"
LO_UP='import fcntl,socket,struct;fcntl.ioctl(socket.socket(socket.AF_INET,socket.SOCK_DGRAM),0x8914,struct.pack("16sH14s",b"lo",0x49,b"\0"*14))'
pass=0; fail=0; failed=()
for f in tests/e2e/*.e2e.js; do
  n=$(basename "$f" .e2e.js)
  [ -n "${1:-}" ] && [[ "$n" != *"$1"* ]] && continue
  if [ "${OFFLINE:-0}" = 1 ]; then
    timeout 300 unshare -n sh -c "python3 -c '$LO_UP' && exec '$NODE' '$f'" > "$OUT/$n.log" 2>&1
  else
    timeout 300 "$NODE" "$f" > "$OUT/$n.log" 2>&1
  fi
  rc=$?
  score=$(grep -E '^[0-9]+/[0-9]+ passed' "$OUT/$n.log" | tail -1)
  if [ $rc -eq 0 ]; then pass=$((pass+1)); else fail=$((fail+1)); failed+=("$n ${score}"); fi
  printf '%s %-45s %s\n' "$([ $rc -eq 0 ] && echo ok || echo NG)" "$n" "$score"
done
echo; echo "合計: ok $pass / NG $fail（ログ: $OUT）"
for x in "${failed[@]}"; do echo "  NG: $x"; done
[ $fail -eq 0 ]
