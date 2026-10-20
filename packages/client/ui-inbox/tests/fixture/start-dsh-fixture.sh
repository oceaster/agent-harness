#!/usr/bin/env bash
# Keyless `dsh web` fixture for the inbox browser proof.
#
# Isolated DSH_HOME (never the live one), no model key, no model call: the
# DeepSeek key is a literal dummy and nothing in the probe sends a prompt. The
# inbox endpoints are stubbed by Playwright route interception in
# inbox-probe.mjs, so no e-server is involved either.
#
# Usage: start-dsh-fixture.sh <port>
# Prints the fixture directory on success; writes it to /tmp/inbox-ui-fixture-current.
set -euo pipefail

REPO_ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../../.." && pwd)
PORT=${1:?usage: start-dsh-fixture.sh <port>}
TMP=$(mktemp -d "/tmp/inbox-ui-fixture.XXXXXX")
mkdir -p "$TMP/home/.agent-presets" "$TMP/workspace"

# Household presets when they exist locally (the deployment installs them from
# here); an empty roster is a valid fixture too.
if [ -d /root/e-server/infra/dsh/presets ]; then
  cp -a /root/e-server/infra/dsh/presets/. "$TMP/home/.agent-presets/"
fi

cd "$REPO_ROOT"
DSH_HOME="$TMP/home" DEEPSEEK_API_KEY=keyless-fixture-not-a-real-key \
  node apps/cli/lib/bin.js --profile web --no-open --port "$PORT" \
  > "$TMP/dsh.log" 2>&1 &
echo $! > "$TMP/dsh.pid"

for _ in $(seq 1 200); do
  if grep -q "http://127.0.0.1:$PORT" "$TMP/dsh.log" 2>/dev/null; then
    echo "$TMP" > /tmp/inbox-ui-fixture-current
    echo "up: $TMP"
    exit 0
  fi
  sleep 0.1
done

echo "fixture did not come up; log tail:" >&2
tail -40 "$TMP/dsh.log" >&2
kill "$(cat "$TMP/dsh.pid")" 2>/dev/null || true
exit 1
