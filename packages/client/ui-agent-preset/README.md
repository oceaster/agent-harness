# dsh-client-ui-agent-preset

English | [中文](README.zh.md)

One surface: a read-only label in the session header naming the [preset](../../preset/agent-presets/README.md) this session runs.

## Why the label is the whole package

A session's preset is fixed when the session is created — the host refuses to adopt an existing session under a different one, because that session's history was produced under the first preset's tools. A control here would promise a switch the host refuses outright, so the surface only reports what is running.

Which agent a conversation uses is decided before it starts: the household inbox row for that person and agent resolves the session, and the deployment's default preset comes from the composition. Nothing in the browser chooses a preset, writes a default, or manages the roster, so the settings row, the new-session chip, and the roster-management section this package used to ship are gone.

## What it reads

One `agentPreset.list` call answers the display copy, issued only once a session reports a preset: a deployment that composes no presets must not pay for a roster read per header. The label reads the preset id from the session's own summary and resolves the name and description against that roster; until the roster answers, and for a preset the roster does not resolve, it shows the id.

Preset files publish one unlocalized `name` and `description`, which Web uses for every `user` row and unknown `system` row. For the four shipped ids (`standard`, `code`, `minimal`, and `cordis`), Web resolves both fields from its active locale only when the roster marks the row `system`; an identically named `user` preset keeps its file metadata.

Forwarded `agent-preset/selected` owner events fold a preset committed in another tab into the session summary this label renders; the initiating tab may already have applied the RPC echo, and the merge is idempotent.

## Where it is mounted

The registration targets `conversation.session.header.mode`, a seat declared by [`dsh-client-ui-conversation`](../ui-conversation/README.md). The shipped conversation skeleton renders the header's actions and utilities but not this seat, so in the current Web composition the label registers and stays invisible. It is kept as that seat's identity label, not as decoration.

## Model Experience

None. The label reads a roster and renders text; [`dsh-agent-presets`](../../preset/agent-presets/README.md) owns what the session's composition puts in front of the model.

#### KV Cache effect

No effect; nothing here reaches a request.

## Known Limitations and Deferred Work

- **A preset without metadata is labelled by id** — display text is optional, and a preset given no name falls back to its directory name rather than presenting an invented one.
- **A failed roster read shows ids** — naming a preset from a refused or stale read would show copy the host no longer confirms, so the label degrades to the id the session recorded.
- **The seat renders nowhere today** — the skeleton has no mount for `conversation.session.header.mode`; a header that mounts it later gets this label without further work.
