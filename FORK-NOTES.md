# Fork notes — oceaster/deepseek-harness

This is a **private fork** of `deepseek-ai/deepseek-harness`, used as the local
build interface ("DSH Local Build") at `/ai/deepseek` on easter-server. It is
pinned to **v0.1.0-rc.8** — the deployed version — deliberately **not** at
upstream HEAD, which has moved far ahead (rc.8 → 0.1.1-rc.2 at fork time).

## Remotes

- `origin`   → `oceaster/deepseek-harness` (this fork)
- `upstream` → `deepseek-ai/deepseek-harness` (the original)

## Embedded changes (the only non-upstream diffs)

Three small "surfaces" are embedded rather than plugin-side, and must be
re-applied on every upstream pull:

1. **Trusted-host proxy patch** — lets the settings/credentials UI work behind
   the Basic-auth proxy. Commits:
   - `1ed4447` allow privileged `/api` methods for trusted hosts
   - `bc2970c` settings work behind trusted-host proxy (loopback→host)
2. **Branding** — no DeepSeek company branding (whale logo removed from the
   sidebar rail and the empty-state hero; no brand slots). Commits `a61a6f3`
   (sidebar brand header) + `af738f6f` (whale/company logo removal).
3. **Session header + Aura dark theme** — two fork-only presentation changes:
   - single-row conversation header (agent-preset label in a dedicated
     `conversation.session.header.mode` seat at the right edge; tabs+utilities
     centered) — commit `f5db1fd`;
   - **Aura dark palette** (OpenCode Aura theme): the `body[data-ds-dark-theme]`
     block in `ui-theme/src/styles/design-platform.css` plus `shiki.css`,
     `gradient-shadow-text.css`, and `web/src/boot-page.module.css` are
     recolored purple (`#a277ff` accent, `#15141b` panels, `#0f0f0f` base,
     `#edecee` text). Light mode is untouched. Re-apply the dark block
     wholesale on upstream pulls — it is marked with an `Aura palette` comment.

Everything else should ship as **plugins**, which stay upstream-agnostic and
are the candidates for open-sourcing.

## Pulling upstream (periodic, deliberate)

```sh
git fetch upstream
git rebase upstream/master            # or merge, then re-apply the three surfaces
# expect conflicts only in: connection, ui-settings*, ui-sidebar, ui-conversation, ui-brand-official, ui-theme
pnpm install && pnpm run build
systemctl restart dsh-web.service
```
