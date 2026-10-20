# Reload persistence: what the browser actually keeps today

Measured, not predicted. One Chromium context, one page, one localStorage origin;
every surface is driven, recorded, `location.reload()`ed, and recorded again.
Raw evidence: `reload-probe.mjs` (the probe) and its `reload-proof.json` output.

```
node packages/client/ui-inbox/tests/fixture/reload-probe.mjs http://127.0.0.1:<port> /tmp/reload-proof
```

## Method

- **Built client from this checkout, not the live one.** `pnpm run build` in the
  worktree (that is `build:lib` host+client faces then `build:web`), so
  `apps/cli/lib` and `apps/web/dist` are this commit's bytes. Build completed with
  `build: recorded 202 client artifact(s) with 1 public value(s)`.
- **Fixture:** `packages/client/ui-inbox/tests/fixture/start-dsh-fixture.sh <port>` —
  keyless `dsh web`, isolated `DSH_HOME`, dummy `DEEPSEEK_API_KEY`, no prompt sent,
  no model call. `/usr/bin/chromium`, viewport 1280x900, `en-US`.
- **Stubs:** `GET /v1/browser/inbox`, `/channels`, `/channels/<id>`, `/open`,
  `/clear`, `/seen` are Playwright route stubs carrying the fields the client's
  parser requires. `/open` does what e-server does server-to-server: it creates the
  conversation on the fixture host over the loopback RPC (`session.create`), so the
  session list the client mirrors is real host state, not a stub.
- **Identity:** the stubbed person is `person-spike`; the two conversations are
  named the way the deployment names them, `session-inbox-person-spike-agent-alpha`
  and `…-agent-beta`.
- **Reload:** `page.evaluate(() => location.reload())` — the real browser reload, so
  localStorage is preserved (same context, same origin) and every in-memory store is
  rebuilt by a real cold boot.
- Probe run: 14 measurements, `failures: []`, `consoleErrors: []`.

## The two answers Owen asked for

**1. Reload with an agent channel open → the agent conversation, not the channel,
not nothing.** Observed: before the reload the centre slot was
`agent-channel-page:Alpha and Beta` with 1 message rendered and the channel row
marked current; after the reload the centre slot is `conversation:composer` (the
previously selected agent conversation), 0 channel messages, no channel row marked.
`dsh.sessions.current` is unchanged across the reload, so the app does not land on
"nothing" — it lands on the *agent conversation*, because the session half persists
and the channel half does not.

**2. Reload with an agent conversation open → the same conversation comes back.**
`dsh.sessions.current` = `{"sessionId":"session-inbox-person-spike-agent-alpha"}`
before and after; the centre slot is `conversation:composer` before and after; the
composer draft typed before the reload reappears in that pane after it (that draft
is stored per session id, so it also proves the same session scope rebuilt). No
stray or different session appeared. Owen's belief that the agent conversation does
not survive is **refuted** in this deployment: the session half works, and that is
exactly why the broken channel half is so visible — the reload silently swaps the
channel for that agent's conversation.

One inconsistency worth naming: the sidebar loses its current-agent highlight across
the same reload (`aria-current` on `ui-inbox-open-agent-alpha` before, none after)
even though the conversation is still open.

## Inventory

"Measured" means an observed value before and after a real reload. Storage key
names are literal localStorage keys.

| State | Where it lives (file · store · persist key) | Survives reload? (measured) | If not, what resets it |
| --- | --- | --- | --- |
| Selected agent conversation | `packages/client/runtime/src/client/sessions/service.ts:284` `createSnapshotStore(selection, { persist: { name: 'dsh.sessions.current' } })` | **YES** — `{"sessionId":"session-inbox-person-spike-agent-alpha"}` before and after; `conversation:composer` in both snapshots | — (restored in the constructor at `service.ts:287`, then validated against the live list at `service.ts:717-733`) |
| Selected agent channel | `packages/client/ui-inbox/src/client/channel-controller.ts:28` `createSnapshotStore<ChannelState>({ … selected: null … })` — **no `persist` option** | **NO** — `agent-channel-page:Alpha and Beta` + 1 message before → `conversation:composer` + 0 messages after | Nothing writes it anywhere. Even a persisted id would be dropped by `channel-controller.ts:45-46`: `open(id)` returns early unless the id is in `rows`, and `rows` is an async boot read (`channel-controller.ts:32-40`) |
| Non-session page (layout `page`) | `packages/client/ui-layout/src/client/stores.ts:64` `init: { …, page: null }`, written by `openPage` at `stores.ts:101`; **`defineStore` without `persist`** (`stores.ts:62`) | **NO** — `agent-channel-page` rendered before → `conversation:composer` after | The store is rebuilt at `null` at boot (`stores.ts:64`); `AppFrame.tsx:240-242` then renders the `conversation` slot instead of `conversation.page` |
| Sidebar width / collapsed | same store (`stores.ts:64` `sidebar: SIDEBAR_DEFAULT`, `setSidebar`, `toggleSidebar` at `stores.ts:71-77`) — **no `persist`** | **NO** — collapsed `56px minmax(0px, 1fr) 0px` / rail occupant before → `280px minmax(0px, 1fr) 0px` / full panel after | Store rebuilt at `SIDEBAR_DEFAULT` at boot (`stores.ts:64`); no key exists — the whole `dsh.*` dump contains no layout key |
| Details width | same store (`stores.ts:64` `details: 0`, `openDetails`/`closeDetails` `stores.ts:99-100`) — **no `persist`** | **UNMEASURED** | Nothing in this fixture can open the column: the only UI caller is the tool-card Inspect path (`ui-conversation/src/client/apply.ts:366-368`), and a keyless conversation holds no tool call. Measured: `data-details-collapsed="true"` in every snapshot. Store has no `persist` either way, so the expectation is "does not survive", but I did not observe it |
| Composer draft | `packages/client/ui-conversation/src/client/stores.ts:26` `persist: 'dsh.conversation.chat'`, scoped by session id at `runtime/src/client/contract/store.ts:212-217` → key `dsh.conversation.chat.<sessionId>` | **YES** — typed `spike-draft-…` before, same text in the textarea after; the key holds `{"selection":null,"draft":"spike-draft-…","view":null,"inspect":null}` in both dumps | — |
| Inbox current-agent highlight (`InboxState.openAgent`) | `packages/client/ui-inbox/src/client/inbox-controller.ts:216` `createSnapshotStore(INITIAL)` — **no `persist`**; set at `inbox-controller.ts:343` | **NO** — `ui-inbox-open-agent-alpha` carried `aria-current="true"` before, no row carried it after | The store is rebuilt empty at boot; only an `open()` click ever sets it again (`inbox-controller.ts:343`) |
| Settings modal (open + active section) | `packages/client/ui-settings-general/src/client/SettingsRoot.tsx:106-107` — plain React `useState` (`open`, `activeId`) | **NO** — dialog open with `Learn More` active before → no `[role=dialog]` at all after | Plain `useState`; the modal is not in any store and no key exists |
| Conversation view tab (`view`) | `ui-conversation/src/client/stores.ts:26` persisted in `dsh.conversation.chat.<sessionId>` (`view` field) | **UNMEASURED** — 0 `[role=tab]` nodes in every snapshot, so there is no UI to drive | Reason: the tab ring renders only when `views.list().length > 1` (`ui-conversation/src/client/skeleton/ConversationSession.tsx:112`) and the header hosting it returns `null` for a non-subagent session (`ConversationSession.tsx:79`). The value is persisted, but this deployment gives it no control |
| Trajectory duration | `packages/client/ui-trajectory/src/client/duration-store.ts:9-12` `createSnapshotStore(false, { persist: { name: 'dsh.trajectory.duration' } })` | **UNMEASURED** — the toggle never existed to click; `dsh.trajectory.duration` never appears in any dump | Reason: the toggle lives in the trajectory toolbar, reachable only through the tab ring described above; the trajectory view never mounted |
| Effort selection | host setting (`ui-model-selection`, trigger `agent-effort-trigger`), not localStorage | **UNMEASURED** — trigger rendered (`Choose effort, current Default`), menu opened, 0 selectable levels | Reason: the keyless fixture composes no effort-capable model, so there is nothing to change and nothing to re-observe |
| Tool-card / plan / goal / jobs / deliverables disclosure | `ui-tool/src/client/tool/components/ToolRow.tsx:149` `useState(false)`; `ui-jobs/src/client/JobListAction.tsx:96`; `ui-plan`, `ui-goal`, `ui-deliverables` likewise local state | **UNMEASURED** | Reason: each renders from a conversation event (tool call, plan, goal snapshot, job row, produced file). The keyless fixture calls no model, so no such event exists to expand |
| Composer blocks | `ui-conversation/src/client/input/blocks.ts:68` `createSnapshotStore<ComposerBlock \| undefined>` — no `persist` | **UNMEASURED / not user state** | A block is transient state another plugin raises (plan mode, no workspace), not a choice a person made. Measured observation: the composer was editable in every snapshot, so no block was ever raised to re-observe |

Not observed at all in this deployment: `dsh.workspace.view.v5` (the workspace
surface is not reachable from the inbox sidebar) — the key never appeared in any
dump, so this probe says nothing about it.

## localStorage keys written by the already-persisted stores

Every `dsh.*` key, per step. Implementation should copy this mechanism
(`createSnapshotStore(init, { persist: { name } })` /
`defineStore({ …, persist: 'name' })` in
`packages/client/runtime/src/client/contract/store.ts:86-147` and `:207-240`), and
must not invent a second one.

| Step | `dsh.*` keys and values |
| --- | --- |
| cold boot, nothing clicked | *(none — `{}`)* |
| conversation open | `dsh.sessions.current` = `{"sessionId":"session-inbox-person-spike-agent-alpha"}` |
| after reload with the conversation open | `dsh.sessions.current` = `{"sessionId":"session-inbox-person-spike-agent-alpha"}` |
| channel open | `dsh.sessions.current` = `{"sessionId":"session-inbox-person-spike-agent-alpha"}` — **no key for the channel, none for the layout page** |
| after reload with the channel open | unchanged from above (the channel left no trace) |
| sidebar collapsed | `dsh.sessions.current` only — **no sidebar/width key** |
| after reload | `dsh.sessions.current` only; the column is back at `280px` |
| draft typed | + `dsh.conversation.chat.session-inbox-person-spike-agent-alpha` = `{"selection":null,"draft":"spike-draft-1792494175279","view":null,"inspect":null}` |
| after reload | both keys unchanged; the draft is back in the composer |
| settings open on Learn More | the same two keys — **no settings key** |
| after reload | the same two keys; the modal is gone |
| final | `dsh.conversation.chat.session-inbox-person-spike-agent-alpha`, `dsh.sessions.current` |

Two persisted stores never wrote a key in this run: `dsh.trajectory.duration` (its
toggle was unreachable) and `dsh.workspace.view.v5` (that surface is absent).

## Identity: is anything namespaced by the signed-in person?

No. Measured, both facts:

- The only person identity that ever reached the client is the inbox list payload's
  `person.id` (`person-spike`) — the client was told who is asking and still wrote
  no person into any key.
- Neither key has a person namespace: `dsh.sessions.current` carries only
  `{"sessionId": …}`, and `dsh.conversation.chat.<sessionId>` is the same
  `persist` name plus the engine's `scopeKey` suffix
  (`runtime/src/client/contract/store.ts:212-217`). The person string appears in
  the dump only *inside* the session id, because the deployment names sessions
  `session-inbox-<profile>-<agent>`. That is an accident of the id shape, not a
  scoping mechanism.
- Every request the page made carried no person either: the recorded inbox traffic
  is `GET /v1/browser/inbox`, `GET /v1/browser/inbox/channels`,
  `POST /v1/browser/inbox/open {"agent":"agent-alpha"}` and avatar/brand asset
  reads — agent ids only, cookie-authenticated.

So: any new person-scoped state has one *de facto* separation today (the session id
inside conversation keys) and none for anything root-scoped. That is the design
question the ticket says not to decide here.

## Root causes, at a line

- **Channel selection does not survive** — `ui-inbox/src/client/channel-controller.ts:28`:
  the store is constructed with no `persist`, and `open()` (`:44-49`) validates an id
  against an async-loaded `rows` list, so persistence alone would not have been
  enough: the selection would also need re-opening after the list arrives.
- **`page` and the panel widths do not survive** — `ui-layout/src/client/stores.ts:62-66`:
  the store is declared with no `persist` and rebuilt at its defaults
  (`sidebar: SIDEBAR_DEFAULT`, `details: 0`, `page: null`).
- **Settings modal does not survive** — `ui-settings-general/src/client/SettingsRoot.tsx:106-107`:
  plain React `useState`, not a store at all.
- **Inbox current-row highlight does not survive** — `ui-inbox/src/client/inbox-controller.ts:216`
  (no `persist`) and `:343` (only a click writes it).
- **The agent conversation does survive** —
  `runtime/src/client/sessions/service.ts:284-286` (persist key), restored at `:287`,
  validated against the live list at `:717`, and *not* overwritten by the boot policy:
  `runtime/src/client/workspaces/service.ts:139-141` returns `state = 'done'` as soon
  as a current session exists, so `startInitialSelection` leaves a restored
  conversation alone.

## Validation limits (what this probe does not prove)

- The fixture has **no workspace**, so `workspaces.startInitialSelection`
  (`runtime/src/client/workspaces/service.ts:126-165`) never reached its
  `connectWorkspace` branch. The "a boot policy overwrites the selection" failure
  mode was therefore not exercised; what is measured is only that a restored
  `current` short-circuits it. The live deployment has workspaces
  (`~/.dsh/sessions/--home-owen--`), so this is the one place a real deployment
  could still differ from the fixture.
- Everything that needs a conversation event (tool card, plan, goal, jobs,
  deliverables, details column, trajectory, view tab) is **unmeasured** for the
  reason given per row: a keyless fixture calls no model, so no event exists.
- Chromium only; one viewport (1280x900). Portrait/narrow behaviour was out of scope
  for this spike (it is covered by `portrait-probe.mjs`).
- Avatars and the brand asset were not stubbed and answered from the fixture host;
  nothing in the measured surfaces depends on them.

## Second pass: the settings modal and disclosure persistence

The rows above marked **UNMEASURED / a keyless conversation holds no event** stopped
being unmeasurable once the fixture could be given events without a model call, so
this pass measures them and records what was persisted.

### Method change: seeded session logs instead of "no event exists"

`seed-disclosure-sessions.mjs` writes two real session logs into the fixture's
isolated `DSH_HOME` before the host starts (`DSH_FIXTURE_SEED=<script>`,
`start-dsh-fixture.sh:25-27`), each carrying a `todo/write` event. The host parses
them and computes the `todos` projection, so the plan strip renders through its
normal path over **real host state** — not a stub.

Two shapes had to be right, and the reader refused the log until both were:
`user/message` requires an identified message (`role` + `id`, else "lacks an
identified message"), and a surface-eligible event requires its `surfaceOp`
marker (else "requires a surfaceOp marker"). The compressed-log format is one
independently-compressed zstd frame per JSONL line, newline included — the reader
rejects a log whose first frame is not exactly one header line.

The `?fixture` wire client was tried first and rejected for this measurement: its
`fx-alpha` session is `running` with a resident pending question, so the composer
is taken over and the only plan strip in the DOM is the hidden
`data-chain-overlay-fallback` copy (0×0, `display:none`). Measuring that would
have been evidence about a node no reader can see.

### Measured, before and after the change

Raw evidence: `reload-proof.before.json` and `reload-proof.after.json` — two
runs of the same probe and fixture method, before and after the change, frozen
beside the probe.

One honest difference between the two artifacts: the stale-key check in the
BEFORE artifact was recorded by the looser version of that step, which left the
open conversation's own stored flag in place. That could not skew its result —
nothing was persisted at all in that build, so no key existed — but the AFTER
artifact and the committed probe use the tightened step, which wipes every
disclosure key and plants only the cleared conversation's. The two verdicts are
worded differently for that reason; the measured values agree.

| Surface | Before | After | Storage |
| --- | --- | --- | --- |
| Settings modal open + active section | **LOST** (`[role=dialog]` gone) | **PRESERVED** (`Learn More` still active) | `dsh.settings.shell` = `{"open":true,"sectionId":"learn"}` |
| Settings modal, left **closed** | stays closed (nothing was stored) | **PRESERVED** — stays closed | `dsh.settings.shell` = `{"open":false,"sectionId":"learn"}` |
| Reopen after a close | **LOST** — reset to `General` | **PRESERVED** — returns to `Learn More` | same key (the id survives `close()`) |
| Plan strip (todo dock) disclosure | **LOST** (`expanded true` → `false`, 3 items → 0) | **PRESERVED** (still expanded, 3 items) | `dsh.conversation.disclosure.<sessionId>` |
| Two conversations, own flags | n/a (nothing stored) | **PRESERVED** — beta stays collapsed while alpha is expanded | per-session suffix |
| Stale key from a cleared conversation | n/a (nothing stored) | **NO LEAK** — only the orphan's key stored, the open conversation still starts collapsed | per-session suffix |
| Settings plugins tab | **UNREACHABLE** — 0 `[role=tab]`, 0 `[role=tablist]` in the dialog | same | none, deliberately |
| Effort selection | lives on the host (`select({provider, model, reasoningEffort})`), **no `dsh.*` key written** | same | none, deliberately |

Mutation checks (each makes the assertion fail, then restored): removing
`persist` from the disclosure store fails 3 of its 6 tests; removing it from the
settings shell store fails 3 of its 8; making `close()` forget the section (the
old behaviour) fails the reopen test in both the store and the component spec.

### Why the plugins tab gets no key

Exactly one package registers a `settings.plugins.tab` entry
(`ui-settings-plugin-inventory`, id `all`), and `PluginsSettingsSection` renders a
lone page **bare** — no tablist — when `rows.length === 1`
(`PluginsSettingsSection.tsx:44-64`). Measured in the browser: no tab control
inside the dialog at all. A persisted tab id would encode a setting for a control
this deployment cannot show.

### Why the remaining disclosures get no key

- **Tool card** (`ui-tool/src/client/tool/components/ToolRow.tsx:149`) — reachable
  in any conversation holding a tool call, but it is `useState` in a package
  outside this change's file scope; flagged rather than silently dropped.
- **Reasoning / context-injection / compaction rows** — mount by transcript
  index (`key={i}`, `AssistantMarkdown.tsx:66`), so a persisted expansion would
  re-expand whichever row later occupies that index.
- **Goal edit form, jobs popover, deliverables Show-more, plan-mode
  transition/error** — transient or non-viewing state; restoring them would
  restore a stuck transition, a stale error banner or an arbitrary cursor.

### Validation limits of this pass

- The settings and disclosure rows are measured on the **keyless host**, one
  viewport (1280×900), Chromium only. Portrait re-verification belongs to
  `portrait-probe.mjs`.
- Effort is measured against the `?fixture` in-memory host, which resets on
  reload; the reload result there therefore says nothing about host durability.
  What it does establish is the fact this ticket needed: the choice is written to
  the host and no `dsh.*` key is involved.
- The two seeded conversations are hand-written logs. They carry the shapes the
  reader validates (and were refused until they did), but they are not output of
  a real model turn.
