#!/usr/bin/env bash
# Spike probe (ticket 5ef4e080) — NOT product source.
#
# Keyless `dsh web` fixture for the reaction-note measurements. It boots the
# real built harness (apps/cli/lib/bin.js) with:
#   - an isolated DSH_HOME (never the live one),
#   - a mock OpenAI-compatible provider (mock-llm.mjs) as DEEPSEEK_BASE_URL, so
#     every model request is recorded instead of paid for,
#   - the probe plugin (probe-plugin.mjs) inserted as a home-level patch row,
#     giving the driver an append/observe surface outside the agent loop.
#
# Usage: start-react-note-fixture.sh <dshPort> <mockPort>
# Prints the fixture directory on success and records it in
# /tmp/react-note-fixture-current.
set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$HERE/../../../../../.." && pwd)
PORT=${1:?usage: start-react-note-fixture.sh <dshPort> <mockPort>}
MOCK_PORT=${2:?usage: start-react-note-fixture.sh <dshPort> <mockPort>}

if [ ! -f "$REPO_ROOT/apps/cli/lib/bin.js" ]; then
  echo "apps/cli/lib/bin.js is missing: run 'npm run build:lib:host' in $REPO_ROOT" >&2
  exit 1
fi

TMP=$(mktemp -d "/tmp/react-note-fixture.XXXXXX")
mkdir -p "$TMP/home/.agent-presets" "$TMP/workspace"

# Household presets when they exist locally; an empty roster is valid too.
if [ -d /root/e-server/infra/dsh/presets ]; then
  cp -a /root/e-server/infra/dsh/presets/. "$TMP/home/.agent-presets/"
fi

# The home-level user patch layer: one inserted row, no product file edited.
cat > "$TMP/home/cordis.patch.yml" <<YAML
# Fixture-only patch layer (spike probe, ticket 5ef4e080).
- insert:
    - id: react-note-probe
      name: $HERE/probe-plugin.mjs
YAML

node "$HERE/mock-llm.mjs" "$MOCK_PORT" "$TMP/mock-requests.json" > "$TMP/mock.log" 2>&1 &
echo $! > "$TMP/mock.pid"

cd "$REPO_ROOT"
DSH_HOME="$TMP/home" \
DEEPSEEK_API_KEY=keyless-fixture-not-a-real-key \
DEEPSEEK_BASE_URL="http://127.0.0.1:$MOCK_PORT" \
  node apps/cli/lib/bin.js --profile web --no-open --port "$PORT" \
  > "$TMP/dsh.log" 2>&1 &
echo $! > "$TMP/dsh.pid"

for _ in $(seq 1 300); do
  if grep -q "http://127.0.0.1:$PORT" "$TMP/dsh.log" 2>/dev/null; then
    echo "$TMP" > /tmp/react-note-fixture-current
    echo "up: $TMP"
    exit 0
  fi
  sleep 0.1
done

echo "fixture did not come up; dsh.log tail:" >&2
tail -60 "$TMP/dsh.log" >&2
echo "mock.log tail:" >&2
tail -20 "$TMP/mock.log" >&2
exit 1
