#!/usr/bin/env bash
# Restart half of the reaction-note fixture (ticket f1bdaed3).
#
# Stops the `dsh web` process start-react-note-fixture.sh began, starts the SAME
# build again on the SAME isolated DSH_HOME, and hands the restart to
# restart-check.mjs — a real process restart with no second checkout and no test
# double in the path.
#
# Usage: restart-check.sh <fixtureDir> <dshPort> <mockPort> <sessionId>
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$HERE/../../../../.." && pwd)
DIR=${1:?usage: restart-check.sh <fixtureDir> <dshPort> <mockPort> <sessionId>}
PORT=${2:?usage: restart-check.sh <fixtureDir> <dshPort> <mockPort> <sessionId>}
MOCK_PORT=${3:?usage: restart-check.sh <fixtureDir> <dshPort> <mockPort> <sessionId>}
SESSION_ID=${4:?usage: restart-check.sh <fixtureDir> <dshPort> <mockPort> <sessionId>}

if [ ! -f "$DIR/home/cordis.patch.yml" ]; then
  echo "not a react-note fixture dir: $DIR" >&2
  exit 1
fi

OLD_PID=$(cat "$DIR/dsh.pid" 2>/dev/null || true)
if [ -n "$OLD_PID" ]; then
  kill "$OLD_PID" 2>/dev/null || true
  # Wait for the port to be released rather than guessing.
  for _ in $(seq 1 300); do
    if ! kill -0 "$OLD_PID" 2>/dev/null; then break; fi
    sleep 0.1
  done
fi

cd "$REPO_ROOT"
DSH_HOME="$DIR/home" \
DEEPSEEK_API_KEY=keyless-fixture-not-a-real-key \
DEEPSEEK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
  node apps/cli/lib/bin.js --profile web --no-open --port "$PORT" \
  >> "$DIR/dsh-restart.log" 2>&1 &
echo $! > "$DIR/dsh.pid"

for _ in $(seq 1 600); do
  if grep -q "http://127.0.0.1:$PORT" "$DIR/dsh-restart.log" 2>/dev/null; then
    node "$HERE/restart-check.mjs" "http://127.0.0.1:$PORT" "$SESSION_ID" "${RESTART_OUT:-/tmp/react-note-proof}"
    exit $?
  fi
  sleep 0.1
done

echo "restarted host did not come up; dsh-restart.log tail:" >&2
tail -60 "$DIR/dsh-restart.log" >&2
exit 1
