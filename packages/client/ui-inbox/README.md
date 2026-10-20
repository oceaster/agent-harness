# @deepseek-ai/dsh-client-ui-inbox

English | [中文](README.zh.md)

This household deployment plugin provides one persistent sidebar inbox row for each agent the signed-in person may use. The authenticated e-server API supplies the roster, names, conversation ids and channel list; the browser carries no household roster.

## Navigation and channels

Agent rows resolve their canonical conversation through `/v1/browser/inbox/open`. The controller refreshes the runtime session list before selecting the returned id, so the composer can bind an existing session. Opening a row creates no arbitrary client-side session. Workspaces are configured per agent by e-server.

Agent Channels occupy the main chat tile through layout's `conversation.page` slot. Channel rows have the same full width and selection feedback as inbox rows. Both row types expose Clear through their dropdown menu and confirmation. Channel pages contain read-only history and Refresh; they have no input, editing controls or model lifecycle. A channel with no messages shows the household mark the unselected welcome screen uses rather than a sentence, while a read still in flight or one that failed keeps its own loading or error row instead of the mark. Selecting an agent row restores its conversation without interrupting ongoing work.

Channel history, available pairs and Clear are scoped to the signed-in person by the backend. Clearing a channel removes its shared history and undelivered notifications; accepted messages remain in the recipient's agent conversation.

## Presence and unread turns

The roster includes disabled agents, which display Offline and Disabled without a launch control. Green means online, red offline, white working, blue an unread completed turn, and amber a terminal turn error. Channel dots are green only when both participants are available. Model retries and recoverable tool failures do not produce amber.

A row reports working while its own turn runs or while any conversation below it still runs, at any depth, and the verb is that agent's own: Delta and Darwin say `Working...`, Diana `Chatting...`, Dexter `Thinking...`, and an agent this build does not know says `Working...`. It also reports working for delegations its payload says are waiting for a worker slot (`queuedWorkers`, server knowledge the browser cannot derive; an absent field reads as none), because outstanding work is not idle time even while nothing runs yet. The line carries one number and only ever one: the total in flight. `Working... (4)` is three running subagents plus one delegation still queued, the dot's accessible label and title carry that same string, and subagents are otherwise invisible in this appearance, so the parent row is where their work shows. There is no working/total pair — the owner read `Working... (3/4)` as broken — and nothing in flight keeps the bare `Working...`, so the line never renders `(0)`. The running part follows the client session store, so a subagent starting or finishing updates the row within a frame without an inbox reload; the queued part follows the payload, so a delegation leaving the queue shows on the next ordinary inbox read the row already performs and can read one refresh stale.

Completed-turn and fatal-error markers come from trusted host events and persist per canonical person/agent conversation. While the corresponding conversation is selected, visible and idle, the browser acknowledges the exact completed sequence it displayed. A later completion remains unread even if the acknowledgment races it. Reading a channel or a sub-agent does not mark its parent inbox read.

## Extension points

Portrait changes the shape and nothing else. The region receives `portrait` from the sidebar shell: the rail then draws only the heads — one glyph per agent row and one per channel row, each keeping its row's accessible name (`Open your conversation with X`, or the channel's own name) and its `aria-current` selected state — and a rail glyph opens that conversation in place instead of unfolding the inbox over the chat. Every selection (an agent row, a rail glyph, a channel row) calls `collapseOnSelection` first, so the chosen conversation gets the screen back in one click; the callback is portrait-only and a no-op while the column is already collapsed, so a manual expand is never undone by a render. Status copy (`Working... (4)` and friends), timestamps, section headings, menus, the refresh control and the settings label are not rendered in rail mode at all, rather than merely hidden.

The plugin occupies `sidebar.workspaces` and registers the `agent-channel` center page. Its slot injection publishes controller snapshots and callbacks; components render only those props. The session-list, workspace-browser and new-session plugins are excluded from this deployment's composition.

## Model Experience

None, as inbox navigation and channel rendering register no model context; agent notification delivery belongs to the e-server host plugin.

#### KV Cache effect

None; this browser plugin neither assembles provider requests nor writes session events.

## Known Limitations and Deferred Work

- Requires the household e-server inbox and channel APIs on the browser origin.
- Channel selection is transient and resets on reload; the backend retains history.
- Channel history displays the latest 200 messages and refreshes while selected.
