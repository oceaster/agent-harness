# Reaction-note fixture (ticket `f1bdaed3`)

English | [中文](README.zh.md)

Measures the host half of the reaction feature against the **real built
harness**: an isolated `DSH_HOME`, a recording mock provider, and the same HTTP
client-request carrier the browser uses. No product file is patched, no API
credit is spent, and nothing here writes to the live `DSH_HOME`.

Design document: the accepted spike,
`NOTE-ONLY-DO-NOT-TOUCH-PRODUCT-SOURCE/reaction-note-spike.md` on
`feat/react-note-spike` (`9d0684d166`). This fixture differs from the spike's in
one decisive way: the note is appended through the REAL `session.react` RPC. The
spike had to reach into the host through a probe plugin because no RPC existed,
so its "the append starts nothing" result was about a hand-written append; here
it is about the wire a client will actually call.

## Files

| File | What it is |
| --- | --- |
| `start-react-note-fixture.sh` | boots `apps/cli/lib/bin.js --profile web` with an isolated home, the mock provider, and the observation plugin as a home patch row |
| `mock-llm.mjs` | OpenAI-compatible stand-in that records every request body; SSE lines copied from `packages/llm/llm-deepseek/tests/mock-server.ts` |
| `observe-plugin.mjs` | observation-only host route (`/react-note-observe`): event counts, the derived message list, the live reaction notes, agent status, inbox depth, surface nodes |
| `drive-react-note.mjs` | the measurement: negative, the next request body, the UI projection, compaction |
| `restart-check.sh` / `restart-check.mjs` | stop the host, start the same build on the same `DSH_HOME`, prove the conversation still opens |
| `evidence/` | the dumps from the run recorded in the ticket submission (`react-note-drive.json`, `react-note-restart.json`); long assembled prompt bodies are truncated in the drive dump and the truncation is stated inside the file |

## Running it

```sh
# From the repository root, after a full build (NOT build:lib:host alone:
# the web profile boots client bundles and apps/web/dist).
npm run clean && pnpm install --frozen-lockfile && npm run build

bash apps/web/tests/fixture/react-note/start-react-note-fixture.sh 3611 3612
MOCK_URL=http://127.0.0.1:3612 DRIVER_CWD=/tmp \
  node apps/web/tests/fixture/react-note/drive-react-note.mjs \
  http://127.0.0.1:3611 /tmp/react-note-proof
# then, with the session id the driver printed:
RESTART_OUT=/tmp/react-note-proof \
  bash apps/web/tests/fixture/react-note/restart-check.sh \
  "$(cat /tmp/react-note-fixture-current)" 3611 3612 <sessionId>
# cleanup: kill "$(cat <fixtureDir>/dsh.pid)" "$(cat <fixtureDir>/mock.pid)"
```

Both scripts exit non-zero when a measurement contradicts its expected shape,
and print a `summary` of every check.

## What it establishes, layer by layer

- **Host + wire (real):** the note is one log-only event with the envelope
  `ignorable` marker, no turn, no model request, no title, no goal/retry/queue
  record, idle agent, empty inbox, unchanged surface — and the host's derived
  history (`Session.deriveMessages()`, the array the loop hands the provider) is
  element-for-element what it was before the append.
- **Provider request body (real):** the note appears NOWHERE in the next turn's
  recorded request. The request is the previous one's messages plus the reply and
  the new prompt, which is the prompt-cache property in measured form.
- **UI projection (real):** `Session.reactionNotes()` reports the note on the
  message it targets, and it lapses when a compaction shadows that message while
  the durable log keeps the record.
- **Compaction (real):** a `/compact` whose span covers the note's seq carries no
  reaction text in the summarisation request, the durable checkpoint, or the
  later request.
- **Restart (real process, same build, same home):** the conversation reopens,
  the note is still there, and the reopened session's model history still carries
  no note at any index.

Not established here: the browser transcript. Its byte-identity is pinned by
`packages/client/ui-conversation/tests/reaction-note-transcript.client.spec.ts`
(the node registry matches no such event, so nothing paints), which is a
stronger guard than a screenshot, but this fixture does not open the web UI.
