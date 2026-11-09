#!/usr/bin/env bash
# 本番で「認証経路が固まる」かどうかを再現・確認するスクリプト。
#   scripts/probe.sh https://example.com [/api/auth/ok /api/auth/get-session /.well-known/oauth-authorization-server ...]
# 1. キャンセル（50ms で切る）を 200 件投げて isolate を汚染させる
# 2. 各経路を 40 回ずつ叩いてタイムアウト（15 秒）の数を数える。auth を触らない経路（/login 等）を対照に入れるとよい
# 直っていれば timeout=0。壊れていると isolate 単位で固まるので 1 割〜9 割がタイムアウトになる。
# 並行して `npx wrangler tail --format json` を溜めておくと、outcome=canceled / cpuTime 数 ms の件数で裏が取れる。
set -u
BASE="${1:?base url}"; shift
PATHS=("$@"); [ ${#PATHS[@]} -eq 0 ] && PATHS=(/api/auth/ok /api/auth/get-session /.well-known/oauth-authorization-server /login)
BURST_PATH="${BURST_PATH:-/api/auth/ok}"; BURST_N="${BURST_N:-200}"; PROBE_N="${PROBE_N:-40}"; PROBE_TIMEOUT="${PROBE_TIMEOUT:-15}"

echo "--- cancel burst: $BURST_N x $BASE$BURST_PATH (cut at 50ms)"
for i in $(seq 1 "$BURST_N"); do
  curl -s -o /dev/null -m 0.05 "$BASE$BURST_PATH" &
  [ $((i % 40)) -eq 0 ] && wait
done; wait

probe() {
  local ok=0 to=0 other=0
  for _ in $(seq 1 "$PROBE_N"); do
    code=$(curl -s -o /dev/null -m "$PROBE_TIMEOUT" -w '%{http_code}' "$BASE$1")
    if [ "$code" = "000" ]; then to=$((to+1)); elif [ "$code" -lt 500 ]; then ok=$((ok+1)); else other=$((other+1)); fi
  done
  printf '%-50s n=%d ok=%d timeout=%d 5xx=%d\n' "$1" "$PROBE_N" "$ok" "$to" "$other"
}
echo "--- probe"
for p in "${PATHS[@]}"; do probe "$p" & done; wait
