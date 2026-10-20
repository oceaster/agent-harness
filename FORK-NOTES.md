# Fork notes — oceaster/deepseek-harness

This is a **private fork** of `deepseek-ai/deepseek-harness`, used as the local
build interface ("DSH Local Build") at `/ai/deepseek` on easter-server. It is
pinned to **v0.1.0-rc.8** — the deployed version — deliberately **not** at
upstream HEAD, which has moved far ahead (rc.8 → 0.1.1-rc.2 at fork time).

## Remotes

- `origin`   → `oceaster/deepseek-harness` (this fork)
- `upstream` → `deepseek-ai/deepseek-harness` (the original)

## Embedded changes (the only non-upstream diffs)

The surfaces below plus generic deployment hooks are embedded rather than plugin-side, and must be
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

6. **Provider-derived model catalog** (`llm-deepseek/src/catalog.ts`, new file,
   plus its wiring in `llm-deepseek/src/index.ts` and the `observeCatalog` hook
   in `adapter.ts`) — the DeepSeek route's advisory catalog follows the
   provider's own `GET ${baseURL}/models` listing instead of the hand-maintained
   `DEFAULT_MODELS` literal that had already drifted (it advertised
   `deepseek-v4-flash` / `DeepSeek-V4-Flash` after the provider moved to
   `deepseek-flash` / `DeepSeek-V4.1-Flash` with 1,048,576 context and 393,216
   output). Re-apply on an upstream pull if `llm-deepseek` is overwritten; the
   new config field is `catalogRefreshMs` (15-minute default, `0` disables).
   The split this surface exists to keep:

   - **Discovery moves the ADVISORY CATALOG only** — ids offered, display names,
     capacities, input modalities. It is read by the model selector, the Models
     page and `ctx.llm.resolveModelInfo`.
   - **A configured model selection is never re-pointed.** Presets, personas and
     `agent/default-model` keep choosing ids explicitly. A selected id the
     listing does not advertise is reported once per process (naming the id and
     the ids the provider does advertise) and served unchanged, because a
     gateway with a partial listing and a provider alias both remain servable.
   - **A pinned `models` list wins wholesale and stops discovery from running.**
     `/root/.dsh/settings.yaml` pins one today, so the discovered catalog is not
     consulted until that block is removed. The pin is detected from the stored
     settings section, not from the resolved value, because the schema defaults
     `models` and a pin equal to the built-in catalog resolves identically.
   - **Failure is never fatal and never blocks a turn.** A missing key, an
     unreachable endpoint, a 404 gateway, a refusal, a malformed or oversized
     reply, and a 200 that advertises no models all keep the last good catalog
     (falling back to the built-in one), report once, and back off (four
     doublings from `catalogRefreshMs`). The keyless smoke
     (`/root/e-server/tests/dsh_smoke.sh`) stays on the pinned list, so no
     discovery request is made there at all.

   **The listing contract for the e-server gateway** (`DEEPSEEK_BASE_URL`
   points at `http://100.100.1.0:8090`, whose `/v1/models` was until now served
   by a shadowed bot-registry route answering `{"object":"list","data":[]}`).
   It must answer `GET /v1/models` as an OpenAI-compatible listing:

   ```json
   {"object":"list","data":[{"id":"deepseek-flash","name":"DeepSeek-V4.1-Flash","context_window":1048576,"max_output_tokens":393216,"input_modalities":["text","image"]}]}
   ```

   `id` is required and must be the id the chat endpoint accepts; `name`/
   `display_name`, `context_window`/`context_length`, `max_output_tokens`/
   `max_tokens`, and `input_modalities` are optional and are trusted only when
   present. An empty `data` array is treated as no information, so a broken
   route degrades to the built-in catalog instead of emptying the selector.
   Bearer authentication is used when the harness has a key for the route.

7. **Permanent session delete** (`session.destroy`, new host RPC) — upstream can
   create, resume, fork, archive and cancel a session but cannot delete one:
   `workspace.archiveSession` only hides a session from grouping surfaces, the
   JSONL log survives, and the projection cache and workspace registry keep
   their rows. This fork needed real deletion so the household inbox's **Clear**
   action can return an agent to a brand-new conversation
   (`/root/e-server/doc/INBOX_SPRINT.md`, decision 4). Packages touched:

   - `packages/session/session-persistence` — the Service Definition grows
     `supportsDestroy` plus `destroy(id)`; the default rejects, the way
     `readRaw`/`supportsRawArtifacts` already fail loud for backends without the
     capability. `PersistenceCoordinator.destroy()` refuses a live identity,
     waits out a draining retirement before taking the id's chain slot, drops
     cached preparations and write state, and calls the new required backend
     hook `removeStored(id)` (returns whether a log existed).
   - `packages/session/session-persistence-jsonl` — `removeStored` unlinks the
     log and the session directory that owns it, then fsyncs the project
     directory.
   - `packages/session/session-persistence-sqlite` — `removeStored` deletes the
     event rows and the metadata row in one transaction (two new SQL resources;
     a first-party backend left without delete would be the half-changed shape).
   - `packages/session/session-projection-cache` — `destroy(id)` drops the
     session's checkpoint row.
   - `packages/workspace/workspace` — `forgetSession(id)` drops archive
     membership, the header/canonical-path index entry and any workspace
     accounting for the id.
   - `packages/api/remotes` — the shared Agent resolver now returns
     `{ agentFor, release }` and keeps the `AgentHandle` of every Agent it
     resumes, because an owner that can resume but not release can stop a
     session but never destroy it.
   - `packages/host/apiproxy` — `session.destroy` in the api contract, its zod
     pair, the rpc-map row, the fetch carrier rows, and the implementation:
     cancel the running turn and await quiescence, drain continuable subagents,
     dispose the live Agent through the handle its creator holds, delete the
     stored logs (the commit point), then drop derived state.

   Behaviour worth preserving on an upstream pull: a destroyed id answers
   `session-not-found` afterwards (never a stale fragment), a second destroy of
   the same id is `session-not-found` rather than a second success, a failure
   before the log deletion reports an error instead of claiming the conversation
   is gone, `origin: 'subagent'` descendants are destroyed recursively with the
   parent while ordinary forks survive (lineage is provenance, not ownership),
   and image attachment objects are deliberately left alone — they are
   content-addressed and shared, so no refcount is invented. A live Agent whose
   handle this host does not hold cannot be disposed, so that case fails rather
   than half-deleting.

   **Authorisation is not part of this surface.** The RPC is loopback and
   trusted-host behaviour like every other session method, and the harness has
   no identity concept: whoever may clear a conversation (e-server's PIN/profile
   proxy, which owns the `dsh_owners` ledger) decides that before calling. No
   profile or ownership concept belongs in the fork. Candidate for an upstream
   PR: the capability is generic, and the only household-specific part is who
   calls it.

8. **Inbox sidebar** (`packages/client/ui-inbox`, new package; plus removals in
   `ui-sidebar`, `ui-conversation` and the web-app composition) — the sidebar is
   an inbox: ONE persistent row per agent the signed-in person may use, from
   `GET /v1/browser/inbox` on the e-server origin (same-origin absolute paths at
   the origin root, the profile cookie as the whole authentication, no identity
   in the plugin). No session list, no New Session button, no workspace browser,
   no hero workspace chip. A per-row three-dot menu holds one action, Clear,
   which confirms and then `POST /v1/browser/inbox/clear`; a `cleared: false`
   answer is rendered as a refusal that keeps the row populated.

   Why the surfaces went rather than being hidden: the hero workspace chip stays
   alive under slot shadowing, and picking a workspace from it minted a STRAY
   blank session with the deployment default preset that landed unowned in
   Owen's inbox. Removal means removal — the `conversation.hero.workspace` hole
   is gone from ui-conversation's ledger, so a stray registrant fails loud.

   **Re-apply on every upstream pull.** The embedded diffs are: ui-sidebar loses
   its New Session button (and the `startSession` inject member, the copy, and
   the `sessions`/`workspaces` service injections it needed); ui-conversation
   loses `EmptyHero`'s `WorkspaceChip`/`workspaceLabel`, the hero workspace row,
   the `conversation.hero.workspace` declaration + `selectWorkspace` inject
   member, and the inert composer's workspace-trigger mode (an inert bar is now
   simply disabled, with its own placeholder); `packages/bundle/web-app`'s
   `cordis.patch.yml` disables the `ui-workspace` row and inserts `ui-inbox`. Upstream will keep trying to bring the session list back —
   that is the conflict to resolve toward the inbox, not away from it. The
   `directory-picker` row STAYS: `host-apiproxy` injects the `directoryPicker`
   service it provides, and disabling it fails the boot ("1 entry did not
   activate", measured in the browser fixture). Its client half fills
   `sidebar.workspaces.directoryFlow`, a hole only the disabled ui-workspace row
   declares, so it never registers — a pending slot injection, not an error.

   The navigation seam is worth rediscovering if upstream rewrites the client
   runtime: `ctx.sessions.open(sessionId)` throws for an id the client's own list
   mirror does not carry, and a conversation e-server created server-to-server is
   exactly that, so the row click pulls the list once (`sessions.refresh()`, a
   wire-pump verb on the concrete `SessionRuntime`, not on the typed `ISessions`
   face, so the plugin resolves that member once at registration and throws a NAMED
   error if it is missing rather than failing with a TypeError under the first row
   click) and only then selects. Clear is `POST` first, `sessions.clear()` only on
   `cleared: true`. The clean follow-up is widening `ISessions` with
   `refresh(): Promise<void>` and every test fake that implements it. The package README (`packages/client/ui-inbox/README.md`)
   carries the full reasoning, the state screens and the API assumptions.

   The cluster runs this through `scripts/sync_dsh.py` like every other fork
   surface, and the deployment needs an e-server origin serving
   `/v1/browser/inbox{,/open,/clear}`; without it the sidebar degrades to a
   visible retryable error row, never a blank panel.

9. **Branded empty conversation** (removals in `ui-conversation`) — a selected
   conversation with no messages used to show the harness's own empty state: the
   "Into the Unknown" headline, a "Preview" badge, and the composer centered
   vertically. It now renders the mark the unselected welcome screen already
   used — the `HeroGlow` ellipse plus the `ec-logo-2-outline` mark e-server
   serves at `GET /v1/browser/inbox/brand.svg`, masked into a soft gradient —
   inside the conversation body, with the composer docked exactly where an
   active chat puts it so the first message moves nothing.

   **Re-apply on every upstream pull.** The embedded diffs are: `ConversationRoot`
   renders the placeholder (`data-testid="conversation-empty"`) as a
   flex-filling sibling of the sticky composer seat and reports only the
   `active` and `settling` phases; `EmptyHero.tsx` becomes `HeroGlow.tsx`
   (`HeroShell` and `HeroShell.module.css` deleted outright); the
   `hero.headline`, `hero.preview` and `placeholder.hero` locale keys are gone in
   both languages, together with the composer bar's `variant` owner prop and
   InputBar's centered card variant — one docked card geometry serves an empty
   conversation and an active one. `settling` is unchanged: the composer seat and
   the placeholder both stay hidden while a blank session's open is loading and
   the list summary does not yet prove it blank. The `apps/web/tests` hero
   anchors (four e2e specs, the two lifecycle-chrome goldens, the placeholder
   lookups in the workspace-flow helpers and the HMR source needle) moved with it.

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
