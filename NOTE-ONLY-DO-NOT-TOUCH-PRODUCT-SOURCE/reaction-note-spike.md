# Spike: a background reaction note that wakes nothing

Ticket `5ef4e080`. No product change was made. Everything below is either a
file:line code path in this worktree (`feat/react-note-spike`, base `320396190f`)
or a measurement from the keyless fixture in
`packages/client/ui-conversation/tests/fixture/react-note/`. Evidence dump:
`packages/client/ui-conversation/tests/fixture/react-note/evidence.json`.

**Superseded as a tool, kept as a record.** The implementation landed in
`f45e50f31f` (FORK-NOTES 26) with its own measured fixture at
`apps/web/tests/fixture/react-note/`, which runs against the shipped code and is
the one to use from now on. This fixture reproduces the pre-change measurement
only, and its mock provider has a known latent flaw that the shipped fixture
fixed: it echoes any reaction text it is shown into *every* reply rather than
only into a compaction request, so a later request could carry text the mock
itself introduced. `evidence.json` was produced with that flaw present. Its
conclusions were read from the recorded request bodies, not from the mock's
replies, so they stand — but do not re-run this fixture expecting clean
compaction evidence.

## Headline

**The mechanism does not exist, and the missing piece is not the append — it is
the model projection.** A reaction note appended as a new log-only event kind is
invisible in the transcript and excluded from compaction *for free*, but it
never reaches the model, because the model-visible message list is built by one
closed switch that returns `null` for every unknown kind. There is no extension
point there.

Also missing, and cheaper than expected: **nothing in the repo can write the
`ignorable` envelope marker today.** `Session.append()` has no way to set it and
no writer sets it anywhere. An append of a new kind is therefore not merely
invisible to the model — it *bricks the session on the next load*, including for
the same build that wrote it. That is measured, not inferred (below).

Minimum correct shape, in one line: one event kind declared in the owning
package, an `ignorable` capability on `Session.append`, one case in
`deriveEventMessage`, one new apiproxy domain, one catalog regeneration. Two
store changes (`ignorable` plumbed write-through) that are *already wired on the
read side*. The UI and compaction exclusions cost nothing. e-server and the 8443
proxy cost nothing.

## 1. How a session event kind is declared, and what an older build needs

- `SessionEventMap` is declared once in `packages/core/session/src/types.ts:236`
  and is merge-extensible by declaration merging: the feature package that owns
  the event re-opens the interface with `declare module '@deepseek-ai/dsh-session/types'`.
  The canonical example is `packages/session/session-title/src/index.ts:90-101`
  (`'session/title'`), with `packages/session/session-title-llm/src/index.ts` for
  its provider. The appendable key set is `SessionEventType = keyof SessionEventMap`
  (`types.ts:340`).
- The envelope is `SessionEvent` in the same file, with `ignorable?: true`
  documented at `types.ts:426`: absent means *required*, and a reader that meets
  an unknown type without it **must refuse** the log. Adding an ordinary event
  type does not bump `SESSION_FORMAT_VERSION` (`types.ts:49-56`) — that marker is
  the vocabulary-growth guard.
- The known vocabulary is a **generated** set:
  `packages/core/session/src/known-event-types.ts:19`
  (`KNOWN_SESSION_EVENT_TYPES`), produced by
  `scripts/gen-persistence-catalog.ts` (`renderKnownEventTypes`, scanned from the
  repo's own `SessionEventMap` declarations) and gated fresh by
  `verify-persistence-catalog` inside `doc-sync`. A new in-repo kind must be
  regenerated into it, and the generated doc artifact with it.
- The refusal is enforced at the persistence coordinator, not the stores:
  `packages/session/session-persistence/src/coordinator.ts:1103-1108`
  (`assertEventsSupported`, called from `:906`, `:926`, `:942`, `:1352`):
  `KNOWN_SESSION_EVENT_TYPES.has(type) || ignorable === true`, else
  `SessionFormatUnsupportedError`.
- Stores: both **accept** a new kind on write and on decode.
  - sqlite: `packages/session/session-persistence-sqlite/resources/sql/schema.sql`
    (`events` table) declares `type TEXT NOT NULL` and
    `ignorable INTEGER CHECK (ignorable IS NULL OR ignorable IN (0, 1))`; write
    `store.ts:384-394`, packed-row encode/decode `compression.ts:95` and `:215`,
    read validation `schema.ts:316-318` (`must be 0, 1, or null`).
  - jsonl: `packages/session/session-persistence-jsonl/src/format.ts:221`
    (`eventLines`) serializes each event object verbatim, so `ignorable` and an
    unknown `data` payload round-trip untouched; the read refusal happens later,
    in the coordinator above.
  - The web profile's session store is the jsonl backend
    (`packages/bundle/base/cordis.patch.yml:98-101`); sqlite backs session-query.
- `Session.append()` (`packages/core/session/src/index.ts:604-655`) builds the
  envelope `{type, seq, time, data, surfaceOp?, sourceEventSeqs?}`. **It cannot
  produce `ignorable`.** `grep` across the repo finds no writer: the only
  occurrences are the two readers (`coordinator.ts:1105`, `compression.ts:95`)
  and tests that fabricate the event with `as unknown as SessionEvent`
  (`packages/session/session-persistence/tests/coordinator-contract.ts:1360-1384`).
  That test is the documented read contract: `ignorable: true` loads, and the
  same event without it raises `event type "future/event" … not marked ignorable`.

Measured consequence (same build, restart, same `DSH_HOME`): after appending one
`reaction/note` event, `session.history` refuses the conversation —

```
SessionFormatUnsupportedError: session "session-b8f58c91…" contains event type
"reaction/note" (seq 23) unknown to this harness and not marked ignorable;
refusing to interpret the log — it was likely written by a newer harness
(raw log: …/session.jsonl.zstd)
```

`session.list` still answered (it reads a small prefix artifact), and the note
itself was in the file (`"type":"reaction/note","seq":23,…,` with no
`ignorable` field). So an append that does not carry `ignorable: true` is a
durable self-inflicted brick, and *the only way to be safe against a build that
predates the merge* — the deployed harness during a rollout — is that marker.

## 2. Cost of the append path

No client-request method can append an arbitrary event. The full
`RpcMethodMap` (`packages/host/apiproxy/src/api/rpc-map.ts`) has `session.prompt`
(wakes a turn), `session.updateQueue`, `session.cancel`, and — as the closest
precedent — `session.rename`, which appends a log-only `session/title` event
without opening a turn (`api/sessions.ts:283-296`, implementation
`src/api-proxy.ts:2376`). Nothing generic.

So it is a new domain, and the repo's own rule
(`packages/host/apiproxy/src/api/index.ts:21`) holds:

| File | Change |
| --- | --- |
| `packages/host/apiproxy/src/api/sessions.ts` | one method signature (`react(...)`) on `SessionsApi`, or a new pair if it deserves its own domain |
| `packages/host/apiproxy/src/api/sessions.schema.ts` | one request/value schema (`sessionEventSchema` at `:41` already tolerates `ignorable: true` and a wide `data`) |
| `packages/host/apiproxy/src/api/rpc-map.ts` | one row: `'session.react': SessionsApi['react']` |
| `packages/host/apiproxy/src/api/index.ts` | one field on `ApiProxy` (only for a new domain, not for a sessions method) |
| `packages/host/apiproxy/src/api-proxy.ts` | the implementation (authority = trusted-host/loopback, see the `session.destroy` docblock for the house stance; `rename` is the working template) |
| client | the browser calls it through `IApiClient` (`packages/client/connection`), so the generated typert remote and the client type face update with the method |

Also required by repo rules once `SessionEventMap` or the append signature
changes, and easy to forget: the generated persistence catalog + docs
(`pnpm run gen-persistence-catalog`, gate `verify-persistence-catalog`), and —
because the two SDKs project the loop independently — the expected outputs in
`examples/jsonrpc-agent/tests/snapshots/` (TypeScript) and
`scripts/snapshots/python-sdk-single-exe/` (Python, `python-runtime` CI job).

**e-server / the 8443 origin needs nothing.** The nginx route is a bare prefix
(`infra/nginx/e-server.conf:283-295`, `location /` → `100.100.1.0:8090/_dsh/`),
and `api/dsh_profile_proxy.py:252-321` forwards any `api/<method>` POST through
generic checks: `same_origin`, a `session_ids()` walk over the payload
(`:151-160`, picks up any `sessionId` key) against the profile-ownership ledger,
and per-method refusals only for names it explicitly lists. A `session.react`
carrying `sessionId` is therefore authorised by construction on the household
origin, and an unknown method is not filtered out.

## 3. The NEGATIVE, measured

Fixture: real built harness (`apps/cli/lib/bin.js --profile web`), isolated
`DSH_HOME`, `DEEPSEEK_BASE_URL` pointed at a recording mock provider, plus a
probe plugin inserted as a home-level patch row (no product file edited). The
probe appends from outside the agent loop — in-process, because no RPC exists;
an RPC handler would perform the same two statements.

Conditions: session on the shipped `code` preset, one ordinary turn completed,
then `reaction/note` appended, then a **3000 ms** observation window.

Observed, all from the host itself (`/react-note-probe/observe`) and the mock's
recorded requests:

| Claim | Evidence |
| --- | --- |
| exactly one event appended, and no other | event-count delta over the whole window = `{"reaction/note": 1}` |
| no model call | mock request count unchanged (`0` new requests) |
| no running state | `agentStatus: "idle"` |
| no queue entry | `inbox.nextTurn: 0, inbox.nextStep: 0`, and no `agent/inbox/spliced` |
| no turn | no `turn/start`, no `step/start` in the delta |
| no title generation | no `session/title`, no `session/title-llm-request` in the delta |
| no budget/retry/goal side effect | no `goal/change`, no `llm/retry*`, no `command/run` |
| no model-visible change | `Session.deriveMessages()` output byte-identical before/after |

Context worth keeping: an ordinary first prompt costs **two** model requests in
this build — the conversation request plus the title provider's own auxiliary
call (`session-title-first-prompt-llm`, observed as
`"Generate the session title from this JSON array…"`). The append did not add a
third.

Limits of this measurement: the goal-round driver and the budget brakes were
observed through their only externally visible surfaces (no `goal/change`, no
retry records, no request). The session had no goal and the brakes were not
tripped before the append, so those two are "no observable effect", not
"instrumented and idle".

## 4. The POSITIVE: what the model actually receives

Same session, one ordinary turn afterwards. Taken from the request body that
reached the provider (not from any claim about code paths).

**The log-only note is absent.** The second turn's request carried 6 messages —
`system`, the first prompt, the runtime-context injection, the skill-catalog
injection, the assistant reply, the second prompt — and no trace of
`[reaction-note]`. The host agreed: `deriveMessages()` still did not contain it.
The reason is one function: `deriveEventMessage` in
`packages/core/session/src/surface.ts:83-112` is a switch over
`'user/message' | 'assistant/message' | 'tool/result'` with
`default: return null` and the comment "merge-extensible union: no assertNever
here". `Session.deriveMessages()` (`index.ts:726`) folds it over the surface, and
`SURFACE_EVENT_TYPES` (`surface.ts:15-19`) is a hardcoded three-element set, so a
new kind cannot even join the surface. **There is no plugin-owned projection
seam for model input.** This is the finding the ticket asked for.

The rule that is missing, concretely: a case that renders the note into a
user-role message, e.g. for `reaction/note`

```
role:   'user'
content: [{ type: 'text', text: '<a person reacted 👍 to the message at seq 12>' }]
source:  { kind: 'plugin', plugin: 'react-note' }
id:      derived deterministically from the event seq (the fold re-runs on
         replay and compaction, so the id must be stable)
```

and it must live in core (`surface.ts`), because that is where the fold is and
it deliberately has no per-kind registration. Anywhere else would be a second,
diverging reconstructor.

**The alternative carrier does reach the model.** Appending the note as a
`user/message` surface event with a plugin source (the shape `agent.inject()`
uses) put it at **index 7 of the next request**, role `user`, verbatim
`"[reaction-note] 🎉 on message seq 2"` — after the previous assistant reply of
the compacted turn and before the new prompt. It cost no turn, no model call and
no inbox entry while pending, exactly like the log-only note.

So the two carriers differ precisely where the ticket cares:
`user/message` gets model visibility for free and leaks everywhere else;
a log-only kind leaks nowhere and is invisible to the model.

## 5. The UI projection: invisible for free, and proven in a browser

The client turns events into transcript nodes in
`packages/client/ui-conversation/src/client/conversation-nodes/` (registration
order in `register.ts:27-37`). Defaults:

- **Append-surface event with no dedicated node** → the generic fallback
  (`fallback.ts:17-21`, `match: event => isAppendSurfaceEvent(event)`) renders an
  `unknown` node containing the event's type and data. That is the leak path for
  a new *surface* kind.
- **Log-only event with no dedicated node** → matched by nothing and dropped. Note
  the registry is not "log-only is ignored": `command/run`, `llm/retry`,
  `turn/end`, `agent/inbox/spliced` and `compaction/*` are log-only events that
  *do* have nodes. A new kind is invisible because no node claims it, not because
  of its envelope shape — so invisibility costs zero files, but it is a property
  of the registry's default, not a statement anyone wrote down.
- **`user/message` with a non-user source** → `message.ts:44-47` matches it and
  renders a `context` node ("Context injection / <plugin>"). That is the leak.

Browser proof (real built web app, real host, real session; household inbox
endpoints stubbed because the fixture is not e-server):

- transcript painted the conversation (`turn one…`, `turn two…`, `turn three`);
- appending the log-only note left the transcript **byte-identical**: the two
  screenshots have the same MD5 (`3049dc71…`), the same 298-element DOM
  signature, no new `data-testid`, no text diff, no console errors;
- appending the `user/message` carrier added a visible `Context injection /
  react-note` row and changed the text.

Two screenshots are in `/tmp/react-note-proof/` from the run; the probe
reproduces them.

## 6. Compaction: free for a log-only note, carried by default for a surface one

Compaction folds **only surface nodes**: `buildSummarizationInput`
(`packages/compaction/compaction-basic/src/region.ts:498-515`) maps
`session.deriveEventMessage(event)` over `shadowedSeqs`, and `shadowedSeqs`
come from the surface fold (`commitCompactionBody`,
`region.ts:427-470`). A log-only event is not in that list, so it is excluded for
free; a `user/message` carrier is in it, so it is included by default.

Measured (`/compact` via the `commands/execute` remote — the same call the
browser makes; note that a `/compact` **prompt** is not a command: slash
dispatch is client-side, so `session.prompt` sends it to the model, which the
fixture showed):

- `Compacted 8 history items (~3315 tokens)`; `shadowedSeqs`
  `[7, 8, 9, 19, 28, 35, 38, 43]` — the `user/message` note (seq 38) is inside,
  the log-only note (seq 23) is not in any surface span.
- The summarization request carried the note's text (`[reaction-note] 🎉 …`);
  it did not carry the log-only note.
- With a summarizer that mentions what it saw (a realistic summary), the note
  landed in the durable checkpoint that the model reads on every later request:
  `<compacted-summary>condensed from history: [reaction-note] 🎉 on message seq 2</compacted-summary>`,
  and appeared twice in the next request (`noteMarkerCountInNextRequest: 2`).
  The checkpoint is also visible in the transcript, so this leaks on both sides.
- The log-only note was absent from the post-compaction request and from the
  host's derived history.

Answer to the owner's hard requirement: **a reaction note carried as a surface
event WOULD be carried across compaction and would need an active exclusion** in
`buildSummarizationInput` (plus a UI exclusion, plus a transcript consequence
via the checkpoint). A log-only kind that never enters the surface is excluded
silently and needs nothing.

## 7. Smallest correct implementation shape

No implementation was written. This is the shape the measurements support.

1. **Event kind**: `reaction/note`, log-only (no `surfaceOp`), payload
   `{ targetSeq: number, emoji: string, actor: string, action: 'added' | 'removed' | 'changed' }`
   declared by the package that owns it (`SessionEventMap` merge, the
   `session-title` pattern), plus `ignorable: true` on every write.
2. **Envelope capability** (the blocker nobody priced): `Session.append()` gains
   an optional envelope marker (e.g. a fourth argument or a dedicated
   `appendIgnorable`), because today nothing in the repo can write
   `ignorable: true` — without it the log is refused by the *next* load, which
   was measured.
3. **Append RPC**: `session.react({ sessionId, targetSeq, emoji, action })`
   returning `{ seq }`. Authority stays where every other session method leaves
   it (trusted host/loopback in the harness; profile ownership by `sessionId` in
   the e-server proxy). No nginx change, no Python proxy change.
4. **Model projection**: one case in `deriveEventMessage`
   (`packages/core/session/src/surface.ts`) rendering a user-role message with a
   deterministic id, plugin source `react-note`, one line of text naming the
   reaction and the message seq it targets. This is a core change; there is no
   plugin seam, and inventing one is a much larger design (it would have to
   exist for every reconstructor: derive, compaction, SDKs).
   *If* core is off-limits, the only alternative is the `user/message` carrier,
   and then items 5 and 6 below become mandatory compensating exclusions.
5. **UI projection**: none for the log-only kind — the node registry already
   drops unclaimed events. Do add a one-line comment or a test pinning that the
   kind stays unclaimed, so a future catch-all node cannot silently start
   rendering it.
6. **Compaction exclusion**: none for the log-only kind (it never enters the
   surface). A test pinning "note text never appears in a summarization request"
   is the cheap guard.
7. **Client behaviour**: on react / un-react / change, fire the RPC and forget it
   — no browser store, no prompt prefixing, no optimistic transcript row. The
   badge is rendered from the log (the note events and/or react events of the
   target message); a failed RPC leaves the badge as the log says it is.
8. **Catalog + SDK expectations**: regenerate the persistence catalog/docs, and
   update the TS and Python SDK expected outputs in the same change.

Rough size: one core append-signature change, one core projection case, one
apiproxy method (+ schema + map row + implementation), one event declaration,
one catalog regeneration, SDK snapshot updates. The reaction UI itself is
separate work.

## What I could not determine

- **How the household deployment's model path treats it.** The fixture spoke to
  the native `deepseek-official` adapter through `DEEPSEEK_BASE_URL`. The live
  household path goes through e-server's gateway (`core/deepseek_gateway.py`) and
  possibly Bedrock; I did not verify byte-for-byte that an injected note survives
  that hop. It is a wire-level proxy, so it should, but that layering is
  e-server's and was not measured here.
- **The goal-round driver and the budget brakes as instruments.** Both were
  observed only through their log/request footprint (no `goal/change`, no
  `llm/retry`, no request). Neither was active during the window, so "no effect"
  is true of the observable surface, not of internals I could read.
- **Any question about the reaction affordance itself.** No reaction UI exists,
  so "the transcript is identical apart from the reaction affordance" is proven
  as "identical", not as "identical plus one badge".
- **A real end-user client round trip.** The append went through a probe HTTP
  route (no RPC exists to call) and the browser proof stubbed the household
  inbox endpoints. The RPC-shaped path (`session.prompt`-style admission,
  `filter_frame` push to the browser, reconnect/resume) is unmeasured until the
  RPC exists.
- **Whether the missing projection case should also serve resumed/forked
  sessions with seeded prefixes.** The fold itself is replay-safe, but I did not
  measure a fork or a resume over a log containing the note (a resume is exactly
  the case that the `ignorable` gap breaks today).

## Reproducing

```
bash packages/client/ui-conversation/tests/fixture/react-note/start-react-note-fixture.sh 3591 3592
MOCK_URL=http://127.0.0.1:3592 PROBE_CWD=<fixture>/workspace \
  node packages/client/ui-conversation/tests/fixture/react-note/probe.mjs http://127.0.0.1:3591 /tmp/react-note-proof
node packages/client/ui-conversation/tests/fixture/react-note/transcript-probe.mjs \
  http://127.0.0.1:3591 <sessionId from the probe dump> /tmp/react-note-proof
```
