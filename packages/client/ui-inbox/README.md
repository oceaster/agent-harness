# @deepseek-ai/dsh-client-ui-inbox

The sidebar's browsing region for the household inbox deployment: **one
persistent row per agent the signed-in person may use**, in the order the
server returns them, each with a three-dot menu whose only action is **Clear**.

This package replaced the upstream session-list sidebar. It is fork-only code
(see `FORK-NOTES.md` at the repository root): a generic deployment does not want
it, and it depends on an API that only the household e-server origin serves.

## The two rules that shaped it

1. **The rows are the person's, never the deployment's.** Every row, name,
   order, state line and conversation id comes from `GET /v1/browser/inbox`.
   This plugin contains **no household agent ids, display names, colours, or
   roster**: a hardcoded roster would silently give Hannah Delta's row, and a
   colour table would be that roster in disguise. The avatar monogram is the
   first character of the name the server sent; the circle uses the shared
   accent token, not a per-agent hue.
2. **Nothing here mints a session.** The removed surfaces (below) all created
   sessions as a side effect of being touched. The inbox only ever asks the
   server to resolve or destroy one `(person, agent)` conversation.

## What replaces what

| Removed | Where it lived | Why it could not stay |
| --- | --- | --- |
| Session list + workspace browser | `ui-workspace` → `sidebar.workspaces` | one row per agent, not per session |
| New Session button | `ui-sidebar` shell top row | minted a session with no owner |
| Hero workspace chip + picker | `ui-conversation` → `conversation.hero.workspace` | measured: the chip stays alive under shadowing, and picking a workspace minted a stray blank session with the deployment default preset that landed unowned in Owen's inbox |
| Directory picker | `host-directory-picker-auto` | it fills the two directory-flow holes `ui-workspace` declared; both are gone |

Removal means removal: no feature flag, no compatibility path, and the removed
slot declaration (`conversation.hero.workspace`) is gone from the ledger, so a
stray registrant now fails loud instead of quietly restoring the control.

## Composition

`packages/bundle/web-app/cordis.patch.yml`:

- `ui-inbox` is the **only** occupant of `sidebar.workspaces`. No priority rank
  is involved — the spike's `priority: -1` shadowing trick existed to sit beside
  `ui-workspace`, and `ui-workspace` is now `disabled: true`.
- Same-priority double registration (the shape that blanks the whole UI) is
  therefore not reachable: there is one registrant, declared once.
- `directory-picker` (the dual-face directory picker) therefore has no hole left to
  fill. It is **not** disabled: `host-apiproxy` injects the `directoryPicker`
  service that row provides, and disabling it leaves the gateway entry pending
  ("1 entry did not activate") — measured in the browser fixture, not assumed.
  Its client half simply never registers, because the hole it fills
  (`sidebar.workspaces.directoryFlow`) is declared by the disabled ui-workspace
  row.

The composer still unlocks without any workspace UI: it unlocks from a Host
workspace **existing**, and e-server seeds one per person at `/root`. Do not add
workspace UI back to make the composer work.

## The navigation seam (the one thing the spike did not prove)

Switching the open conversation from a click is `ctx.sessions` — the client
runtime's sessions service, in `packages/client/runtime/src/client/`.

```
1. POST /v1/browser/inbox/open {agent}   → { sessionId }
2. sessions.refresh()                    ← only if the mirror lacks that id
3. sessions.open(sessionId)              ← the conversation the pane shows
```

The trap, and the reason step 2 exists: `sessions.open()` delegates to
`SessionManager.select()`, which **throws** for an id its own summary mirror does
not list (`sessions.select: unknown session <id>`). That mirror is the browser's
session list, and the inbox writes out of band — e-server created the
conversation on the harness host, so existing on the host is not the same as
being in the mirror. `SessionRuntime.create()` merges browser-created sessions
into the mirror; the inbox deliberately does not use that path.

Two details that are easy to get wrong:

- **`refresh()` is not on the typed `ISessions` face, and that is a known,
  deliberate divergence.** The runtime keeps the wire-pump verbs
  (`handleMuxEnvelope`, `handleConnected`, `refresh`) on the concrete
  `SessionRuntime`, which is what it provides as `ctx.sessions`, so
  `src/client/index.ts` reaches for it through one explicit structural type at
  the seam and nothing else in the package casts. Because such a read compiles
  whatever the runtime actually exposes, the plugin resolves it **once at
  registration** and throws a named error if it is not a function
  (`the client runtime no longer exposes sessions.refresh; the inbox open path
  depends on it`) — a loud boot failure instead of a TypeError under the first
  row click. The follow-up that removes the divergence is widening `ISessions`
  with `refresh(): Promise<void>` plus every test fake that implements it; that
  touches other packages' fixtures, so it was not done here.
- **The pull is once per click**, never per render and never in a loop. If the
  pull fails (a restarting harness) or the id still never appears, that is an
  **open failure rendered on the row** — never a selection of stale state, and
  never an "opened" row pointing at a pane that cannot show it.

As a second line of defence the controller also waits (bounded, subscription —
not a poll) for the id to reach the list, which covers a `host/session-added`
broadcast that is merely late.

Clear is the same seam's third verb: `POST /clear` first, and `sessions.clear()`
only when the answer says `cleared: true`. That drops the current selection so
the pane falls to the no-session state and wipes the persisted selection, so a
reload does not re-open a destroyed conversation. A refused clear leaves the
conversation open and says so.

## States

Real screens, each with its own copy — not an empty list:

- **loading**: "Loading conversations…" (no rows yet).
- **ready, zero rows**: "No agents yet" — a signed-in person whose deployment
  composes nothing for them (e.g. a profile whose only agent is disabled). No
  retry, because nothing failed.
- **refused** (`GET` answers 403): "The Agent Harness is not available to this
  profile". The e-server profile middleware refuses the guest profile before any
  inbox route exists, so this is a refusal from the server, not a failure of the
  read — and retrying cannot change it, so the screen offers no retry control.
  Deliberately distinct from both the empty list and an error.
- **error**: the reason plus a retry control. A failed *refresh* keeps the rows
  from the last good read on screen and states the failure above them.
- Per row: a failed open, a failed clear, a `cleared: false` refusal, or an
  unshowable conversation is a plain sentence under that row. A conversation
  that still exists is never rendered as cleared.
- The boot read never throws into cordis: an unreachable API is the same visible
  failure with a retry control, and no promise rejection escapes.

Live badges (`running`, `blank`) do not poll: the session list the browser
already receives is folded into the matching row, and the list is re-read on
reconnect (`connection/reset`) plus on demand from the header control.

## Menu and dialog

- The three-dot menu exists on every row, is a real `button` with
  `aria-haspopup="menu"`, and holds exactly one action: Clear. Escape and an
  outside pointer-down close it (the shared `Menu` primitive, portal mode —
  the sidebar clips its own overflow).
- Clear opens the shared `Modal` confirmation: the title names the agent
  ("Clear your conversation with Delta?", from the API's `name`) and the body
  states the messages are permanently deleted. Escape, the mask, and Cancel all
  cancel; focus lands on Cancel and Tab/Shift+Tab stay inside the dialog.
- The rail (56px collapsed column) renders one monogram per agent; clicking it
  expands the column and opens that conversation. Clear lives in the wide row
  menu.

## API assumptions (reconcile before merge)

Built against the fixed contract with stubs. The assumptions this code makes:

1. The three endpoints are **same-origin absolute paths at the origin root**
   (`/v1/browser/inbox`, `/v1/browser/inbox/open`, `/v1/browser/inbox/clear`),
   never under the page's `/_dsh/` prefix, and the profile cookie is the whole
   authentication (`credentials: 'same-origin'`). The plugin sends no identity.
2. `agents` is already filtered and ordered; empty is a valid answer. The panel
   never sorts, merges, hides, or adds rows.
3. `sessionId` and `lastActivityAt` are `null` exactly when `hasConversation` is
   false; `blank` means "conversation exists, no messages"; `running` is the
   host's "a turn is in flight" summary bit; `lastActivityAt` is epoch **seconds**.
4. `open` is idempotent; `created` is true only for a new conversation. The
   response's `sessionId` is exactly the id the pane must show.
5. `open` 502 (`hostUnavailable`) means the host could not seed the conversation
   — rendered as an open failure, never as success. 409 (`agent-preset-conflict`)
   is rendered as a real error on the row. 403 = agent outside the caller's
   roster; 401 = no profile; 503 = harness restarting.
6. `clear` 200 with `cleared: false` means the conversation survives: the row is
   re-rendered from the payload's own fields and a refusal sentence is shown.
   Clearing an empty row is a no-op success (`cleared: true`).
7. A row's agent id is opaque (a preset id). It is used only as an opaque key
   and sent back verbatim; nothing client-side interprets it.
8. No response field beyond the contract is required. Anything unexpected in a
   200 body is treated as `malformed` rather than guessed at, so a row can never
   be invented from a partial payload.
9. Per-request budget is 20s (`createInboxApi`'s timeout); expiry reads as a
   retryable failure, not a hang.

## Verification

What is asserted by a unit test, and what only the browser run proved — they are
not interchangeable:

**Unit tests (`tests/*.client.spec.*`, `pnpm run test:gui` / vitest):**

- `tests/inbox-api.client.spec.ts` — paths, bodies, every refusal status,
  transport rejection, unreadable 200 bodies, timeout.
- `tests/inbox-controller.client.spec.ts` — rows from the payload in order, empty
  list, refusal vs failure, exactly one open call per click, no session named
  before the answer, refresh-once-then-select, 409/502 as row failures, clear
  success/refusal/failure, pane reset only on a real clear, live badge folding
  without requests.
- `tests/inbox-panel.client.spec.tsx` — row rendering, the three state lines, the
  menu holding exactly one action, the confirm dialog's copy, Escape/mask/Cancel,
  focus trap, keyboard reachability, and each of the four whole-panel screens.
- `tests/browser-plugin.client.spec.tsx` — one registration with no rank, the
  hooks compartment, boot read, degradation when the API is unreachable, a click
  reaching `sessions.open()` with the returned id, and the loud registration
  failure when the runtime stops exposing `sessions.refresh`.

**Browser proof (`tests/fixture/`, a real headless Chromium against a keyless
`dsh web` fixture with the three endpoints stubbed by Playwright route
interception — no model call, no live e-server, no real harness data):** the six
screenshots the ticket names plus the rail and the failure screen, and these
claims that only a browser can make:

- the rows paint, in payload order, with the three state lines and the menus;
- the confirm dialog, Escape, the outer cancel and the focus move are real DOM
  behavior, not jsdom;
- exactly ONE `POST /v1/browser/inbox/open` per row click, and the pane then
  shows the conversation the server returned (the seam end to end);
- the composer accepts typed text with no workspace click and no chip;
- no `New Session` control, no `Choose workspace` chip, no session list and no
  workspace browser anywhere in the DOM;
- the guest 403 renders the refusal screen (no retry control) and is not the
  empty-list screen;
- an unreachable inbox API degrades to the error screen, the retry re-reads, and
  no page error or unhandled rejection escapes.

Notes on reading the browser transcript:

- Chromium logs one `Failed to load resource: ... 4xx/5xx` line per refused
  response. Those lines are the guest 403 and the two 503s working as designed;
  the probe counts page console errors separately and requires zero of them.
- The one control in the composer that says "Workspace …" is the **sandbox
  permission preset** (`Workspace Write`, from ui-permission-presets), not a
  workspace control: it selects tool access, and it is not the removed chip.

Reproduce:

```sh
pnpm run build                                     # client bundles + frontend dist
bash packages/client/ui-inbox/tests/fixture/start-dsh-fixture.sh 3271
node packages/client/ui-inbox/tests/fixture/inbox-probe.mjs http://127.0.0.1:3271 /tmp/inbox-ui-proof
```

The fixture uses an isolated `DSH_HOME` under `/tmp` (never the live one), a
keyless dummy key, and cleans up its own directory; stop it with
`kill "$(cat /tmp/inbox-ui-fixture-current/dsh.pid)"`.

## Model Experience

None directly: this plugin adds no prompt content and no model-visible input.
What it changes is how a conversation is *entered* — the model sees the session
the person opened, exactly as any other session, and nothing about the inbox row
reaches the prompt.

### KV Cache effect

None. The inbox never writes session events; opening a conversation is a client
navigation, so a cached prefix is unaffected by how the person got there.
