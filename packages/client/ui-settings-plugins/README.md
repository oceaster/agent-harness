# dsh-client-ui-settings-plugins

English | [中文](README.zh.md)

The **Plugins** settings section. It owns the heading, the intro line, and the tab chrome; feature plugins contribute read-only pages through `settings.plugins.tab`. This package contributes no page of its own.

## What appears here

The section projects the `settings.plugins.tab` ledger — one entry per contributing plugin, ordered by the contribution's `order` and labelled by its registrant — and mounts what comes back. Today the ledger holds a single page: the read-only inventory registered by [`ui-settings-plugin-inventory`](../ui-settings-plugin-inventory/README.md).

One page is not a choice, so a lone contribution renders under a plain title instead of inside a tab bar: a strip holding one button reads as a control the reader is expected to press, and there is nothing to switch to. A second contribution restores the real tab strip, where a tab mounts on its first selection and stays mounted while hidden, so a page's disclosure state and search text survive switching.

## No configuration here

Customisation of this deployment is a server decision, changed only on the server. So this section carries no card, no form, and no write path: the three editable host-plane cards it used to ship (`shell`, `agent-loop`, `web-search-deepseek`) are deleted rather than hidden behind a flag, and the keyed `settings.plugin.item` slot they hung from is no longer declared.

Deleting the cards changes no plugin behaviour. Those settings namespaces are owned by the plugins that registered them, not by this page, and their defaults are untouched: the shell executor keeps `timeoutMs` 120000 and `maxOutputBytes` 64000 (with `maxTimeoutMs` 600000, `maxSpillBytes` 64 MiB and `graceMs` 3000, none of which a card ever edited), the agent loop keeps `maxParallelToolCalls` 10, and the DeepSeek search provider keeps `maxUses` 5, its endpoint from `$DEEPSEEK_SEARCH_BASE_URL` or `https://api.deepseek.com/anthropic/v1`, and its key from `DEEPSEEK_API_KEY`. A value already stored in the deployment's settings document still applies, because the owning plugin reads that document whether or not a browser card exists; changing one is now a server-side edit.

## Extension point

The section declares `settings.plugins.tab`, a root list slot whose labels become ordered tabs. A plugin contributes a page with `ctx.slots.inject('settings.plugins.tab', …)` and owns that page's component, copy and data — including whether it is read-only. Contributing needs no dependency on this package beyond the slot declaration it already receives.

## Model Experience

None, as this package renders browser chrome and writes nothing, so it reaches no model at all.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The section writes nothing, by design** — an in-browser edit path would need a Host contract for user-owned plugin settings plus a package that stages and fences those writes. Neither exists here any more, so plugin configuration is not a browser capability at all.
- **A lone contribution drops the tab bar** — with one page the contribution's label becomes a plain heading. That is the intended reading of a single view, but it does mean the chrome changes shape when a second page is contributed.
- **A visited page stays mounted** — a contributed page remains mounted once selected so its local state survives switching tabs, so every page the reader has visited stays live until the section unmounts.
