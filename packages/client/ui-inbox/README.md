# @deepseek-ai/dsh-client-ui-inbox

English | [中文](README.zh.md)

This household deployment plugin provides one persistent sidebar inbox row for each agent the signed-in person may use. The authenticated e-server API supplies the roster, names, conversation ids and channel list; the browser carries no household roster.

## Navigation and channels

Agent rows resolve their canonical conversation through `/v1/browser/inbox/open`. The controller refreshes the runtime session list before selecting the returned id, so the composer can bind an existing session. Opening a row creates no arbitrary client-side session. Workspaces are configured per agent by e-server.

Agent Channels occupy the main chat tile through layout's `conversation.page` slot. Channel rows have the same full width and selection feedback as inbox rows. Both row types expose Clear through their dropdown menu and confirmation. Channel pages contain read-only history and Refresh; they have no input, editing controls or model lifecycle. Selecting an agent row restores its conversation without interrupting ongoing work.

Channel history, available pairs and Clear are scoped to the signed-in person by the backend. Clearing a channel removes its shared history and undelivered notifications; accepted messages remain in the recipient's agent conversation.

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
