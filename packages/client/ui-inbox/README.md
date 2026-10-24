# @deepseek-ai/dsh-client-ui-inbox

English | [中文](README.zh.md)

This household deployment plugin provides one persistent sidebar inbox row for each agent the signed-in person may use. The authenticated e-server API supplies the roster, names, conversation ids and channel list; the browser carries no household roster.

## Navigation and channels

Agent rows resolve their canonical conversation through `/v1/browser/inbox/open`. The controller refreshes the runtime session list before selecting the returned id, so the composer can bind an existing session. Opening a row creates no arbitrary client-side session. Workspaces are configured per agent by e-server.

Agent Channels occupy the main chat tile through layout's `conversation.page` slot. Channel rows have the same full width and selection feedback as inbox rows. Both row types expose Clear through their dropdown menu and confirmation. Channel pages contain read-only history and Refresh; they have no input, editing controls or model lifecycle. A channel with no messages shows the household mark the unselected welcome screen uses rather than a sentence, while a read still in flight or one that failed keeps its own loading or error row instead of the mark. Selecting an agent row restores its conversation without interrupting ongoing work.

Channel history, available pairs and Clear are scoped to the signed-in person by the backend. Clearing a channel removes its shared history and undelivered notifications; accepted messages remain in the recipient's agent conversation.

## Two interfaces in one shell: the epsilon sidebar

Owen, 2026-10-23: "2 separate interfaces BUT SAME SAME, DIFFERENT, BUT SAME". This package fills ONE sidebar region with two bodies: the Delta entry shows `InboxPanel` — agent rows and Agent Channels — and the Epsilon entry shows `EpsilonPanel`, the list of Delta's sub-agents.

Owen, 2026-10-24: the workspace is an IDE — "always rendered and rendering ... if closed, it's actually just 'not-visible'" — so both interfaces stay mounted and one is hidden. `sidebar.workspaces` stays single-consumer: `SurfacePanels` is its ONE registrant and owns the switch internally. The registry rejects a second occupant at the same priority, and a mid-session re-registration would dispose the live entry and mount a fresh panel, which is the remount this exists to remove, so the switch is the occupant's own state rather than a second registration. A hidden interface holds NO subscription (`surface-gate.ts`): no store frame re-renders it and no timer wakes it, while its DOM and whatever the person left in it — an open row menu, a confirm dialog — stay mounted. Showing it again reads the live snapshot, so a returning interface is never stale.

Which interface shows is decided two ways that cannot disagree. The URL fragment, read once at boot in `surface.ts`, keeps every cold load, bookmark and pasted link landing where it always has; the parent page's `dsh:open` message (`surface-controller.ts`) is the mechanism, so moving between the entries costs no document load. The parent keeps ONE frame with ONE `src` and posts `{ type: 'dsh:open', surface, conversation, token }` with an exact target origin (never `'*'`); the app answers `dsh:ready` with that token and `dsh:route` whenever the person navigates inside it, so the parent's URL and menu can follow without reloading anything. Messages are applied only when they change something, and only the parent may send them. An interface that has never been shown is not mounted, so a cold load still contains exactly one; the parent's first message makes both resident and every later move a visibility flip.

Polling follows the same rule. The agent-channel poll runs only while the inbox interface is showing, Delta's sub-agent roster only while the Epsilon interface is, and neither runs while the frame is off screen (`frame-shown.ts`) — each re-reads once on activation, so a paused poll is never a stale panel. The frame budget is measured, not asserted: `tests/instant-surfaces.journey.mjs` drives e-server's composed browser fixture (`tests/browser_profiles.sh`) through a ten-step journey and reports document loads, frame navigations, and intent-to-paint milliseconds per switch.

**Sub-agents are not in the inbox sidebar.** A person reading their inbox or a peer channel sees their agents and channels and nothing else; the epsilon interface has no agent row or channel section in its tree at all.

**The roster is Delta's, not the pane's.** The epsilon sidebar lists the direct children of the signed-in person's DELTA conversation — the catalog `/v1/browser/inbox` resolves for that person, refreshed through `sessions.refreshSubagents(parentSessionId)` — so the list is populated before any worker is open, and opening one does not empty it. Reading the open conversation's catalog instead is what made the list appear only once a worker was already on screen, which is not a list of Delta's sub-agents.

Each worker is a row built from the same row component and the same styles as an agent row — avatar, presence dot, name, one state line — and its second line is the durable creation label the harness recorded (what the worker was asked to do). A worker is named once, in long form (`Epsilon 3`), on its own row; the short form (`E3`) is the avatar monogram, and the row never prints the name twice. A child the harness enumerated but could not identify is listed as a damaged row with no launch control, because the harness's reason for it is the truth, not something this panel can repair. There is no row menu: a worker cannot be cleared from here.

Opening a worker hands `sessions.openSubagent` the exact address its row carries (parent, child, mode); nothing is fetched and nothing is created. The conversation column then paints that worker through the harness's own components — `ConversationRoot`, `ChatView`, `AssistantMarkdown`, `MessageItem`. Nothing in this package draws a transcript, a bubble or a message row: there is no second copy of the chat surface here to drift, and a worker's conversation carries no parent/child breadcrumb either (the session header renders nothing).

Read-only is the fork's rule, not this panel's, and this deployment's rule is stronger than a restyled composer: `ConversationRoot` paints the composer seat only when `readOnly` is false, and `readOnly` is `child || childSummary` — so a subagent conversation (addressed or listed) has NO composer seat in the tree at all, for a one-shot worker and a continuable one alike. No CSS here could produce that, and none tries. (`SubagentReadOnlyComposer` remains the composable seat for a deployment whose root keeps a seat; in this fork the `!readOnly` gate settles it first.)

The rows follow the harness's selection, so the open worker is the current row in the epsilon interface; while a worker is open no agent row claims it, exactly as no agent row claims a session it does not own.

## Presence and unread turns

The roster includes disabled agents, which display Offline and Disabled without a launch control. Green means online, red offline, white with a rotating ring while working (a static open ring under reduced motion), blue an unread completed turn, and amber a terminal turn error. Channel dots are green only when both participants are available. Model retries and recoverable tool failures do not produce amber.

A row reports working while its own turn runs or while any conversation below it still runs, at any depth, and the verb is that agent's own: Delta and Darwin say `Working...`, Diana `Chatting...`, Dexter `Thinking...`, and an agent this build does not know says `Working...`. It also reports working for delegations its payload says are waiting for a worker slot (`queuedWorkers`, server knowledge the browser cannot derive; an absent field reads as none), because outstanding work is not idle time even while nothing runs yet. The line carries one number and only ever one: the total in flight. `Working... (4)` is three running subagents plus one delegation still queued, the dot's accessible label and title carry that same string, and subagents are otherwise invisible in this appearance, so the parent row is where their work shows. There is no working/total pair — the owner read `Working... (3/4)` as broken — and nothing in flight keeps the bare `Working...`, so the line never renders `(0)`. The running part follows the client session store, so a subagent starting or finishing updates the row within a frame without an inbox reload; the queued part follows the payload, so a delegation leaving the queue shows on the next ordinary inbox read the row already performs and can read one refresh stale.

Completed-turn and fatal-error markers come from trusted host events and persist per canonical person/agent conversation. While the corresponding conversation is selected, visible and idle, the browser acknowledges the exact completed sequence it displayed. A later completion remains unread even if the acknowledgment races it. Reading a channel or a sub-agent does not mark its parent inbox read.

## Extension points

Portrait changes the shape and nothing else. The region receives `portrait` from the sidebar shell: the rail then draws only the heads — one glyph per agent row and one per channel row, each keeping its row's accessible name (`Open your conversation with X`, or the channel's own name) and its `aria-current` selected state — and a rail glyph opens that conversation in place instead of unfolding the inbox over the chat. Every selection (an agent row, a rail glyph, a channel row) calls `collapseOnSelection` first, so the chosen conversation gets the screen back in one click; the callback is portrait-only and a no-op while the column is already collapsed, so a manual expand is never undone by a render. Status copy (`Working... (4)` and friends), timestamps, section headings, menus, the refresh control and the settings label are not rendered in rail mode at all, rather than merely hidden.

The plugin occupies `sidebar.workspaces` and registers the `agent-channel` center page. Its slot injection publishes controller snapshots and callbacks (including `openWorker`, which forwards one catalog-derived address to `sessions.openSubagent`); components render only those props. The session-list, workspace-browser and new-session plugins are excluded from this deployment's composition.

## Model Experience

None, as inbox navigation and channel rendering register no model context; agent notification delivery belongs to the e-server host plugin.

#### KV Cache effect

None; this browser plugin neither assembles provider requests nor writes session events.

## Known Limitations and Deferred Work

- Requires the household e-server inbox and channel APIs on the browser origin.
- Channel selection is transient and resets on reload; the backend retains history.
- Channel history displays the latest 200 messages and refreshes while selected.
