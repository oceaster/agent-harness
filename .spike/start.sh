#!/usr/bin/env bash
# Isolated dsh web fixture for the inbox spike. Keyless: the DeepSeek key is a
# literal dummy and no prompt is sent, so no model call can occur.
# Usage: start.sh <port> <mode: baseline|no-workspace>
set -euo pipefail
ROOT=/root/worktrees/inbox-ui-spike
PORT=${1:?port}
MODE=${2:-no-workspace}
TMP=$(mktemp -d "/tmp/inbox-spike-${MODE}.XXXXXX")
mkdir -p "$TMP/home/.agent-presets"
cp -a /root/e-server/infra/dsh/presets/. "$TMP/home/.agent-presets/"
if [ "$MODE" = "no-workspace" ]; then
  PATCH_ARGS=(--patch "$TMP/probe.patch.yml")
  cat > "$TMP/probe.patch.yml" <<'YML'
# Spike overlay: the workspace browser's row is disabled, so the sidebar's
# `sidebar.workspaces` hole is filled only by ui-inbox.
- id: ui-workspace
  disabled: true
YML
else
  PATCH_ARGS=(--patch "$TMP/baseline.patch.yml")
  printf '# Spike baseline: no overrides; ui-workspace keeps the sidebar hole.\n[]\n' > "$TMP/baseline.patch.yml"
fi
echo "$TMP" > "/tmp/inbox-spike-${MODE}-current"
cd "$ROOT"
DSH_HOME="$TMP/home" DEEPSEEK_API_KEY=keyless-fixture-not-a-real-key \
  node apps/cli/lib/bin.js --profile web "${PATCH_ARGS[@]}" --no-open --port "$PORT" \
  > "$TMP/dsh.log" 2>&1 &
echo $! > "$TMP/dsh.pid"
for i in $(seq 1 100); do
  if grep -q "http://127.0.0.1:$PORT" "$TMP/dsh.log" 2>/dev/null; then echo "up: $TMP"; exit 0; fi
  sleep 0.1
done
echo "did not come up; log:"; tail -40 "$TMP/dsh.log"; exit 1
