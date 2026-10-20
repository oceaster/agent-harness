# Reaction-note probe fixture (spike, ticket 5ef4e080)

Keyless, throwaway measurement rig for "can a background note reach the agent's
next run without starting a turn?". **Not product source, not a test suite, not
wired into any gate.** Findings and the recommendation live in
`/NOTE-ONLY-DO-NOT-TOUCH-PRODUCT-SOURCE/reaction-note-spike.md`.

What makes this a real harness and not a stub: it boots the actual built
`apps/cli/lib/bin.js --profile web` with an isolated `DSH_HOME`, and the only
substitutions are (a) the provider endpoint, pointed at `mock-llm.mjs`, and
(b) the append trigger, which is a home-level patch row mounting
`probe-plugin.mjs` — because **no RPC exists that appends an arbitrary session
event**, which is itself part of the finding. No product file is edited.

## Files

| File | Role |
| --- | --- |
| `start-react-note-fixture.sh` | boots the fixture: isolated home, home patch row, mock provider, `dsh web`; prints the fixture dir |
| `mock-llm.mjs` | OpenAI-compatible recording provider; replays one text generation whose SSE lines are copied verbatim from `packages/llm/llm-deepseek/tests/mock-server.ts` (`textEvents`); echoes any reaction note it is shown so a summary visibly carries it |
| `probe-plugin.mjs` | host cordis plugin: `POST /react-note-probe/append` (log-only kind or `user/message` carrier), `GET /react-note-probe/observe`, `GET /react-note-probe/model-input` |
| `probe.mjs` | drives the fixture: negative measurement, next-turn request dump, both carriers, compaction |
| `transcript-probe.mjs` | Chromium proof that the log-only note changes nothing in the transcript while the `user/message` carrier does |
| `evidence.json` | the dump one successful run produced (trimmed message bodies) |

## Running it

Needs a built worktree (`npm run build` — `build:lib:host` alone leaves the
client bundles and the web dist missing, and the web profile will not boot).

```sh
bash packages/client/ui-conversation/tests/fixture/react-note/start-react-note-fixture.sh 3591 3592
# prints: up: /tmp/react-note-fixture.XXXXXX

MOCK_URL=http://127.0.0.1:3592 PROBE_CWD=/tmp/react-note-fixture.XXXXXX/workspace \
  node packages/client/ui-conversation/tests/fixture/react-note/probe.mjs \
  http://127.0.0.1:3591 /tmp/react-note-proof
# exits non-zero when a measurement contradicts its expected shape

node packages/client/ui-conversation/tests/fixture/react-note/transcript-probe.mjs \
  http://127.0.0.1:3591 <sessionId from the probe dump> /tmp/react-note-proof
```

Clean up with the pid files in the fixture directory (`dsh.pid`, `mock.pid`).

## Two traps this fixture hit, worth keeping

- `/compact` typed into the composer is **not** a command prompt: slash dispatch
  is client-side, so `session.prompt` with `/compact` sends that text to the
  model. The probe therefore calls the typert remote the browser calls —
  `POST /api/commands/execute` with `{ args: { agentId, line, images } }`, the
  named-args payload, not a positional array.
- The web profile disables `compaction-basic` and `command-compact` at host
  level; they come from the agent preset, so the probe creates the session with
  `agentPreset: 'code'` (a shipped preset) or `/compact` does nothing.

## Why the session ids are dated, not fixed

The fixture home outlives a probe run only if you reuse the directory, and a
fresh `session.create` per run keeps the transcript and the compaction span
honest. `transcript-probe.mjs` takes the session id as an argument for the same
reason.
