# Fork notes — oceaster/deepseek-harness

This is a **private fork** of `deepseek-ai/deepseek-harness`, used as the local
build interface ("DSH Local Build") at `/ai/deepseek` on easter-server. It is
pinned to **v0.1.0-rc.8** — the deployed version — deliberately **not** at
upstream HEAD, which has moved far ahead (rc.8 → 0.1.1-rc.2 at fork time).

## Remotes

- `origin`   → `oceaster/deepseek-harness` (this fork)
- `upstream` → `deepseek-ai/deepseek-harness` (the original)

## Embedded changes (the only non-upstream diffs)

The four original surfaces plus generic deployment hooks are embedded rather than plugin-side, and must be
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
4. **Tool-call name preservation** (`llm-deepseek/src/translate.ts`) — the
   upstream translator used `if (call.function?.name !== undefined)`, which
   treats a `null` name in later deltas as present and wipes the name captured
   from the first delta (the GO backend streams name/id once, then `null`/`""`).
   Every tool call ended up with `name: ""`. Changed to truthy checks
   (`if (call.function?.name)` / `if (call.id)`), plus a regression test in
   `llm-deepseek/tests/translate.spec.ts`. This is an upstream bug fix — a
   candidate for upstream PR; re-apply if an upstream pull overwrites it.
5. **Provider-scoped env credentials** (`llm-pi-ai`) — a provider route could
   carry only one secret (`apiKeyEnv` → pi-ai's `apiKey`), so a route that signs
   with SigV4 over a credential *set* could not authenticate from the harness
   credential store: Amazon Bedrock (and Vertex, and Azure) need an access key
   id plus a secret plus a region. A route now also accepts `env` (plain
   provider-scoped values such as `AWS_REGION`) and `envCredentials` (env-var
   name → credential reference). References resolve per request through the
   same `ctx.credentials` → `launchEnvironmentOf` seam `apiKeyEnv` uses, fail
   loud as `MISSING_CREDENTIAL` rather than letting pi-ai fall back to ambient
   AWS identity, and reach pi-ai as `StreamOptions.env`. Merged as `4be1712`.
   This is a generic seam, not an AWS special case — candidate for upstream PR.

Everything else should ship as **plugins**, which stay upstream-agnostic and
are the candidates for open-sourcing.

## Model options from the household AWS account

The `amazon-bedrock` route in `$DSH_HOME/settings.yaml` (category **Amazon Web
Services** in the model selector) is deployment data, not fork code: 50 models
enabled for account 446241389971 in us-east-2, SigV4 from two credential refs in
`$DSH_HOME/.credentials.yaml`, `AWS_REGION` as a plain route value. No preset or
personality defaults to any of them; they exist as selectable options. The
inventory, its selection rule and how to refresh it are recorded in the e-server
repository (`infra/aws/bedrock-models.yaml`, `doc/AWS_BEDROCK_MODELS.md`).

## Pulling upstream (periodic, deliberate)

```sh
git fetch upstream
git rebase upstream/master            # or merge, then re-apply the four surfaces
# expect conflicts only in: connection, ui-settings*, ui-sidebar, ui-conversation, ui-brand-official, ui-theme
pnpm install && pnpm run build
systemctl restart dsh-web.service
```

## Easter personality deployment hooks

`agent/default-model` supplies a blank session's personality default without
overriding explicit or logged model selection. Selection assembly also updates
the route inherited by in-process children, including reasoning effort.
`subagent/authorize` denies both one-shot and continuable starts before allocation.
The CLI respects explicit preset roots. Keep these generic hooks on upstream
updates; personality prose, presets, ticket tools and storage belong to the
e-server plugin at `/root/e-server/infra/dsh/`.

The cross-repository assembled smoke is `bash /root/e-server/tests/dsh_smoke.sh`.
It uses the actual built DSH profile with an isolated home, scripted LLM and
temporary ticket service; it never spends API credits. Existing uncommitted
DeepSeek adapter edits are separate from the personality upgrade.
