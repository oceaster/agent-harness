# @deepseek-ai/dsh-client-ui-inbox

English | [中文](README.zh.md)

This household deployment plugin provides one persistent sidebar inbox row for each agent the signed-in person may use. The authenticated e-server API supplies the roster, names, conversation ids and channel list; the browser carries no household roster.

## Navigation and channels

Agent rows resolve their canonical conversation through `/v1/browser/inbox/open`. The controller refreshes the runtime session list before selecting the returned id, so the composer can bind an existing session. Opening a row creates no arbitrary client-side session. Workspaces are configured per agent by e-server.

Agent Channels occupy the main chat tile through layout's `conversation.page` slot. Channel rows have the same full width and selection feedback as inbox rows. Both row types expose Clear through their dropdown menu and confirmation. Channel pages contain read-only history and Refresh; they have no input, editing controls or model lifecycle. A channel with no messages shows the household mark the unselected welcome screen uses rather than a sentence, while a read still in flight or one that failed keeps its own loading or error row instead of the mark. Selecting an agent row restores its conversation without interrupting ongoing work.

Channel history, available pairs and Clear are scoped to the signed-in person by the backend. Clearing a channel removes its shared history and undelivered notifications; accepted messages remain in the recipient's agent conversation.

## Presence and unread turns

The roster includes disabled agents, which display Offline and Disabled without a launch control. Green means online, red offline, white working, blue an unread completed turn, and amber a terminal turn error. Channel dots are green only when both participants are available. Model retries and recoverable tool failures do not produce amber.

A row reports working while its own turn runs or while any conversation below it still runs, at any depth: the row shows `Working...`, and with at least one running subagent the live count is inline as `Working... (2)`, in the same string the dot's accessible label carries. Subagents are otherwise invisible in this appearance, so the parent row is where their work shows. The count follows the client session store, so a subagent starting or finishing updates the row without an inbox reload, and a row with no running subagent shows no count at all rather than `(0)`.

Completed-turn and fatal-error markers come from trusted host events and persist per canonical person/agent conversation. While the corresponding conversation is selected, visible and idle, the browser acknowledges the exact completed sequence it displayed. A later completion remains unread even if the acknowledgment races it. Reading a channel or a sub-agent does not mark its parent inbox read.

## Extension points

The plugin occupies `sidebar.workspaces` and registers the `agent-channel` center page. Its slot injection publishes controller snapshots and callbacks; components render only those props. The session-list, workspace-browser and new-session plugins are excluded from this deployment's composition.

## Model Experience

None, as inbox navigation and channel rendering register no model context; agent notification delivery belongs to the e-server host plugin.

#### KV Cache effect

None; this browser plugin neither assembles provider requests nor writes session events.

## Known Limitations and Deferred Work

- Requires the household e-server inbox and channel APIs on the browser origin.
- Channel selection is transient and resets on reload; the backend retains history.
- Channel history displays the latest 200 messages and refreshes while selected.
