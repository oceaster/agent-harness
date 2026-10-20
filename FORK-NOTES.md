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
   the list summary does not yet prove it blank. The placeholder is gated on
   proven emptiness (`openState === 'open' || summaryBlank === true`) exactly as
   the deleted hero was, so a `cold` or failed open never paints "no messages"
   over a conversation whose history was not read.

   **The `apps/web` hero-anchor edits that go with it are UNVERIFIED, and that
   lane needs its own ticket.** At this base commit `lifecycle-chrome`,
   `startup-auto-selection`, `goal-command-presentation`,
   `details-session-lifecycle` and `conversation-column-overflow` fail before
   reaching any line this change touches: the first four stop in
   `connectFreshWorkspace` on `getByRole('textbox', { name: 'Choose workspace' })`
   (30 s timeout) and the last on its boot-state selector, because this fork
   removed the workspace chip and picker (surface 8 above) and a
   conversation-less boot now paints the branded welcome screen instead of a
   hero. So the four e2e anchor edits, the three placeholder lookups in the
   workspace-flow helpers and snapshot/init scripts, and the two hand-edited
   `lifecycle-chrome` goldens (`hero.expected.md`, `plan-active.expected.md`)
   are kept for reference alignment but are NOT proven by a run; they must be
   re-recorded and executed by the ticket that drives selection through the
   inbox API. The only `apps/web` spec verified here is `hmr-live.e2e.ts`, whose
   needle moved to `'welcome.select'` and which passes; the browser proof of the
   placeholder itself is `packages/client/ui-conversation/tests/fixture/`.
10. **Branded boot page** (`packages/client/web/src/boot-page.ts` +
   `boot-page.module.css`, plus the `setTotal` call it drops in
   `packages/client/web/src/boot.ts`) — the framework-free page the shell
   paints before any client plugin activates used to be the `HARNESS` wordmark,
   a rotating spinner whose arc grew from 72° to 288° as loader entries
   activated, and a `Loading plugins…` line. It is now the household mark: the
   welcome screen's soft blue backdrop ellipse (figma 313:14109, inlined as SVG
   so it needs no fetch) behind the `ec-logo-2-outline` logo, which is a CSS
   mask over a cool-grey gradient exactly the way ui-conversation's welcome
   screen paints it. Nothing else about the page changed.

   **The failure report is the reason this page exists and it is untouched.**
   `render()` still switches the card to `Failed to load plugins` plus the
   per-entry failed ids and the `fail(message)` text, on the same
   framework-free path (no React, no theme delivery, no plugin CSS), and the
   branded mark stays beside it. `packages/client/web/tests/boot-page.client.spec.ts`
   asserts that, and `apps/web/tests/settings-chrome.e2e.ts` anchors its reload
   on the new mark instead of the removed `Loading plugins…` line.

   Two constraints hold this shape in place:

   - **The mark is deployment-agnostic.** The mask points at the ABSOLUTE path
     `/v1/browser/inbox/brand.svg` on the e-server origin — the same reference
     the inbox/conversation art uses, which resolves identically inside the DSH
     iframe and on the standalone page. On a deployment without e-server that
     request 404s, and that is survivable by design: the mask paints nothing,
     so the mark degrades to invisible, no exception escapes, the fixed-size
     logo box keeps the card's geometry, and the failure report still renders.
     Do not "fix" this into an import or a themed token; the boot page cannot
     assume either exists yet.
   - **No progress indicator survives.** The arc was the spinner's, so
     `updateProgress()`, the `--dsh-boot-arc` variable, the `active`/`total`
     bookkeeping and the public `setTotal()` are gone rather than stubbed. The
     page-load screen shows no progress at all, which is why the browser lane
     waits on `data-dsh-boot-mark` (the kernel handoff still finds the page by
     `data-dsh-boot` on the root). If upstream later brings a progress surface
     back, add it here deliberately instead of reviving the arc.

   **Re-apply on every upstream pull** (the stylesheet is also where surface 3's
   Aura dark block lives, so a pull can conflict twice in one file — keep the
   `#0f0f0f`/`#edecee` dark fallbacks and this mark together):

   ```diff
   --- a/packages/client/web/src/boot.ts
   +++ b/packages/client/web/src/boot.ts
   @@ -106,7 +106,6 @@
        const rows = this.manifest.plugins.map(row => row.id)
   -    this.page.setTotal(rows.length)
        await prefetching

   --- a/packages/client/web/src/boot-page.ts
   +++ b/packages/client/web/src/boot-page.ts
   @@ class BootPage fields
   -  private readonly wordmark: HTMLDivElement
   -  private readonly spinner: HTMLDivElement
   -  private readonly hint: HTMLDivElement
   +  private readonly mark: HTMLDivElement
      private readonly states = new Map<string, LoaderEntryState>()
   -  private readonly active = new Set<string>()
   -  private total = 0
      private failure: string | undefined

   @@ constructor
   -    this.wordmark = div(css.wordmark, 'HARNESS')
   -    this.spinner = div(css.spinner)
   -    this.spinner.dataset.dshBootSpinner = ''
   -    this.hint = div(css.hint, 'Loading plugins…')
   -    this.card.append(this.wordmark, this.spinner, this.hint)
   +    this.mark = div(css.mark)
   +    this.mark.dataset.dshBootMark = ''
   +    this.mark.setAttribute('role', 'status')
   +    this.mark.setAttribute('aria-label', 'Loading')
   +    const logo = div(css.logo)
   +    logo.dataset.dshBootLogo = ''
   +    this.mark.append(glow(), logo)
   +    this.card.append(this.mark)
        this.root.append(this.card)
        container.append(this.root)
   -    this.updateProgress()
   -  }
   -
   -  setTotal(total: number): void { this.total = total; this.updateProgress() }

   @@ setState
        this.states.set(id, state)
   -    if (state === 'active') this.active.add(id)
   -    this.updateProgress()
        this.render()

   @@ render (loading branch)
        if (this.failure === undefined && failed.length === 0) {
   -      if (this.spinner.parentElement !== this.card) {
   -        this.card.replaceChildren(this.wordmark, this.spinner, this.hint)
   +      if (this.card.childElementCount !== 1 || this.card.firstElementChild !== this.mark) {
   +        this.card.replaceChildren(this.mark)
          }
          return
        }
   @@ render (report branch)
   -    this.card.replaceChildren(this.wordmark, report)
   -  }
   -
   -  private updateProgress(): void {
   -    const ratio = this.total === 0 ? 0 : Math.min(this.active.size / this.total, 1)
   -    this.spinner.style.setProperty('--dsh-boot-arc', `${String(Math.round(72 + ratio * 216))}deg`)
   +    this.card.replaceChildren(this.mark, report)
      }

   --- a/packages/client/web/src/boot-page.module.css
   +++ b/packages/client/web/src/boot-page.module.css
   @@ palette
   -  --dsh-boot-label-tertiary / --dsh-boot-border / --dsh-boot-brand
   +  --dsh-boot-mark-from / --dsh-boot-mark-mid / --dsh-boot-mark-to
      (cool grey for the light fallback, the welcome screen's own values in the
       dark block: the boot page paints on pure white, the welcome screen on a
       themed panel, so the untinted grey is darkened for light only)
   @@ removed
   -.wordmark { … }  .hint { … }  .spinner { … }  .spinner::after { … }  @keyframes spin { … }
   @@ added
   +.mark { position: relative; display: grid; place-items: center; width: min(420px, 84vw); height: 176px; }
   +.glow { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
   +.logo {
   +  position: relative;
   +  width: clamp(112px, 22vw, 144px);
   +  aspect-ratio: 755 / 712;
   +  opacity: 0.42;
   +  background: linear-gradient(145deg, var(--dsh-boot-mark-from), var(--dsh-boot-mark-mid) 52%, var(--dsh-boot-mark-to));
   +  mask: url('/v1/browser/inbox/brand.svg') center / contain no-repeat;
   +  -webkit-mask: url('/v1/browser/inbox/brand.svg') center / contain no-repeat;
   +}
   ```

   The full geometry and comments are in the source: the glow keeps only the
   `feGaussianBlur` from `EmptyHero`'s `HeroGlow` (the `feFlood`/`feBlend` pair
   there hides the backdrop behind the shape and a standalone art element has
   nothing to blend against), and the ellipse is `cx 525.5 cy 234 rx 425.5
   ry 134`, `#6187D8` at 0.08.

11. **Learn More settings tab** (`packages/client/ui-settings-learn`, new package;
    plus one browser-roster row in `packages/bundle/web-app/cordis.patch.yml`)
    — **HISTORICAL, DELETED by entry 19: the tab and its package are gone; do
    not re-apply anything this entry lists.** It replaced the Settings modal's
    Agent Presets tab with a **Learn More** tab that explains, per agent the
    signed-in person may use, what that agent is for, how it works, what it will not do and how to work with it. The copy
    is household content owned by **e-server** (`api/learn_routes.py` serving
    `context/agent-guides.json` at `GET /v1/browser/learn`), so the plugin holds
    no agent id, agent name, section id or sentence of prose: it renders whatever
    arrives, in the server's order, and editing the guides needs no browser
    rebuild. The tab sits between General and Plugins (`settings.section`,
    `id: learn`, `order: 5`).

    Three facts about that route the tab is built around, each measured, not
    assumed:

    - **A refusal is not an empty list.** e-server answers Guest
      `403 {"detail": "DSH is unavailable to Guest"}` before the learn route
      runs, while an authenticated profile whose roster resolves to no agent
      answers `200 {"agents": []}`. Both are real and they mean different
      things, so the tab has separate screens for them — and the refusal offers
      no retry, because retrying cannot change a policy answer.
    - **`sections[].id` is not an enum.** Delta and Darwin carry
      `what-it-is-for` / `how-it-works` / `what-it-will-not-do` / `how-to-use-it`
      plus `waiting-and-workers` or `waiting-and-handoff`; Diana carries the
      first four plus `memory-and-privacy`. A hardcoded section set would drop
      one the day the content is edited, so the count of agents, their names and
      every section are read from the payload.
    - **Failures carry FastAPI's `{"detail": …}`** — a string for
      `HTTPException(500, "…")`, which is the sentence naming the agent whose
      guide is missing, and an object for `HTTPException(502, {error, code,
      message})`. The tab shows that sentence verbatim and uses its own copy only
      when the body has none: a generic "failed to load" over a server sentence
      that names the problem is a worse product.

    **Re-apply on every upstream pull.** The package itself is a plugin and
    survives a pull; the embedded pieces are the three registration surfaces a
    new client plugin needs, and a pull that rewrites the bundle patch or the
    aggregates drops all three: the `ui-settings-learn` row in
    `packages/bundle/web-app/cordis.patch.yml`
    (`name: '@deepseek-ai/dsh-client-ui-settings-learn'`), its dependency entry
    in `packages/bundle/web-app/package.json`, and its project reference in
    `tsconfig.client.json`. The tab reads the guides on first render rather than
    at plugin load (a person who never opens it costs no request), and it does
    not poll: a guide edited in e-server appears on the next page load.

    **Layer proven here:** the package suite proves the wire parsing (every
    status, every `detail` shape, and a payload with a section missing), the
    controller's four states, and the rendered sheet against the real payload
    copied out of e-server. The composed surface — this tab inside the real
    modal, behind the PIN proxy, against the live route — is the coordinator's
    post-merge browser gate, not this package's proof.

12. **Slimmed Settings and composer** (removals in `ui-agent-preset`,
    `ui-permission-presets`, `ui-conversation`, `ui-settings-models`, and
    `bundle/web-app/cordis.patch.yml`) — the household Settings modal now offers
    only what a family member controls. Which agent a conversation uses is
    decided by the inbox row that starts it, permission is always full access,
    and models are server-side (the gateway routes them; the composer's effort
    slider picks the effort), so four surfaces that contradicted those facts are
    gone.

    **Settings.** `ui-agent-preset` registers one seat, the read-only
    `conversation.session.header.mode` label; its `settings.general.item` row
    (id `agent-preset`), its `settings.section` (id `agent-presets`), the
    new-session `conversation.hero.agentPreset` chip, and the roster-management
    controller behind them are deleted rather than stubbed. The label reads the
    roster for display copy only — nothing in the browser writes a preset
    default. Note that the seat renders nowhere today: the shipped skeleton
    renders the header's actions and utilities but not `header.mode`, so the
    label is registered and invisible until a header mounts it. The
    `ui-permission-presets` package is deleted outright, together with its
    `/permission` popupSelect decoration: a decorated picker on a typed slash
    command is still an affordance, and keeping a package alive for a value
    nobody may change is not worth it.

    **Composer.** `PermissionSelect` is deleted from `ui-conversation` (its
    component, CSS, `input.accessMode`/`access.confirm.*` copy, its seat in the
    input bar's bottom row, its `permissions` projection read, and the now
    unowned `command` inject face on the composer bar). The bottom row keeps the
    plan seat, the model/effort seat, the context meter and send.

    **Composition rows touched in `packages/bundle/web-app/cordis.patch.yml`**
    (three workers shared this file; reconcile by id):
    - `permission` — new override row pinning full access as the only level:
      `defaultPreset: danger-full-access` plus a preset table whose only entry
      is `danger-full-access` (`sandbox: danger-full-access`, `approval: never`).
      The host builds its settings schema from the table's names, so no other
      value resolves: `/permission workspace-write` now fails with
      `unknown preset ...` instead of switching, and a stale settings document
      naming a removed preset fails loudly at load.
    - `ui-settings-models` — `disabled: true`, which also removes its two
      `settings.onboarding` dialogs (the welcome notice and the DeepSeek key
      dialog). Disabled rather than deleted, following the `ui-workspace`
      precedent recorded in that file.
    - `ui-permission` — row deleted with the package.
    - `ui-agent-preset` — row kept; only its comment changed.

    Language, Appearance and the busy Enter-behavior rows are untouched. The
    host `/permission` command itself still exists in
    `packages/interaction/permission-presets`; the pin, not the missing UI, is
    what refuses a downgrade.
13. **Read-only Plugins tab** (`packages/client/ui-settings-plugins`, plus one
   copy line in `packages/client/ui-settings-plugin-inventory`)
   — **HISTORICAL, DELETED by entry 19: both packages and the tab are gone; do
   not re-apply anything this entry lists.** It made the Plugins section a
   read-only window, because customisation in this household is universal and
   server-controlled, so a family member may see what the deployment runs but
   not edit it. The configurable page and its
   three cards (Agent loop, Bash, Web search) are deleted rather than
   flag-hidden: `ConfigurablePluginsTab.tsx`, the three `*Card.tsx`, the two
   card controllers plus `web-search-card-controller.ts`, `card-form.ts`,
   `fields.tsx`, `PluginCard.tsx`, `tab-store.ts` and `slot-contract.ts` are
   gone, the `settings.plugin.item` slot is no longer declared, and the browser
   half now injects only `slots` and `locale`.

   Three consequences worth keeping on an upstream pull:

   - **The chrome follows the contribution count.** One page renders under a
     plain heading; the tab strip (with its arrow/Home/End keyboard contract)
     returns only when a second `settings.plugins.tab` contribution exists. A
     one-button tab bar read as a control the reader was expected to press.
   - **The honest line lives in the inventory tab.** `serverManaged` says
     configuration is set on the server by Delta and that this page is
     read-only, and it renders in every state, the failure state included.
   - **The host-plane defaults are untouched**, because those namespaces belong
     to the plugins that registered them, not to the deleted cards: shell
     `timeoutMs` 120000 / `maxOutputBytes` 64000 (`maxTimeoutMs` 600000,
     `maxSpillBytes` 64 MiB and `graceMs` 3000 were never card fields), agent
     loop `maxParallelToolCalls` 10, DeepSeek search `maxUses` 5 with endpoint
     from `$DEEPSEEK_SEARCH_BASE_URL` or
     `https://api.deepseek.com/anthropic/v1` and key from `DEEPSEEK_API_KEY`. A
     value already stored in `$DSH_HOME/settings.yaml` still applies — the
     owning plugin reads it — so deleting the cards reverts no stored override;
     that file holds no section for any of the three on easter-server.

   Re-apply on an upstream pull: those deletions, the section's
   single-contribution branch, and the `serverManaged` copy. The generated slot
   catalog (`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts`,
   `pnpm run gen-client-catalog`) drops its `settings.plugin.item` entry.

14. **Portrait layout** (`packages/client/ui-layout` + `ui-sidebar` +
   `ui-inbox`) — a portrait-shaped frame (width < height) behaves like a phone
   app instead of a squeezed desktop. Owen asked for it in his own words: the
   inbox auto-collapses whenever an item is selected, expanding does not squeeze
   the chat but covers it with a dimming scrim, at mobile widths the panel is a
   full-frame slide-in from the left, and while collapsed it is a transparent
   overlay carrying only the floating heads and a floating expand control.

   The shape is a SECOND geometry contract in `ui-layout/src/client/columns.ts`,
   solved beside the concession chain and never mixed with it: `computeColumns`
   is still the landscape answer, `computeFrameLayout` picks between the two,
   and the comparison is strict (`width < height`), so a square frame keeps the
   old chain. `ui-layout/README.md` carries the contract.

   Numbers, chosen from the measurements rather than guessed:

   - **Portrait panel width** is 62% of the frame, capped at 620px
     (`SIDEBAR_PORTRAIT_RATIO` / `SIDEBAR_PORTRAIT_MAX`). Half the frame was
     rejected because 50% of the reference 800px-wide portrait frame is 400px —
     below the 420px landscape clamp, so it could not be "much wider". At
     800x1200 the floating panel is 496px.
   - **Mobile breakpoint** 600px (`PORTRAIT_MOBILE_MAX`): at or below it the
     expanded column spans the frame and slides in from the left.
   - **The chat column keeps its width in both portrait states** (the sidebar
     owns no grid track in portrait), and reserves the 56px rail as a padding
     inset, so neither the heads nor the expand button sit on the chat's text.
   - **Scrim** `#000` at opacity 0.55, inert (`aria-hidden`, no handlers); the
     cover-and-dim is the scrim plus the floating panel, never a squeeze.

   The auto-collapse is a selection event, not a render effect: the sidebar
   shell hands the region `portrait` and `collapseOnSelection`, and the inbox's
   three selection paths (agent row, rail glyph, channel row) call it before
   opening. It writes the narrow override, never the width preference, is a
   no-op when already collapsed, and does nothing in landscape — so a manual
   expand survives until the next selection and every landscape frame is
   untouched. A rail glyph in portrait opens its conversation in place instead
   of unfolding the inbox over the chat.

   The collapsed portrait rail is transparent (`ui-sidebar` drops its fill) and
   renders no header, refresh, menus, state lines, timestamps or settings label
   — those are absent from the tree in rail mode, not made transparent, so no
   keyboard user can tab into a control they cannot see. Rail glyphs keep each
   row's accessible name and `aria-current` state, and the channel rows now
   appear in the rail too; the fold control is named **Expand inbox**
   (`portrait.expand`) there, since it expands the inbox rather than a generic
   sidebar.

   Re-apply on an upstream pull: `columns.ts` (portrait constants, `isPortrait`,
   `planPortrait`, `computeFrameLayout`), the portrait block in
   `AppFrame.module.css` plus the `data-portrait*` attributes in `AppFrame.tsx`,
   the `portrait`/`collapseOnSelection` owner props (`SidebarOwnerProps`,
   `SidebarSectionOwnerProps` — both also recorded in the generated
   `slot-catalog.ts`), the portrait rail rule in `SidebarRoot.module.css`, and
   the rail/selection changes in `ui-inbox`. The browser evidence is
   `packages/client/ui-inbox/tests/fixture/portrait-probe.mjs` against the
   keyless `dsh web` fixture at 390x844, 800x1200, 1200x800 and 1280x900.

15. **Client state persists across reloads** (`ui-layout`, `ui-inbox`, and the
   `partial` picker in `runtime/src/client/contract/store.ts`) — Owen's rule:
   all state in the harness app must survive a reload, especially the
   contact/channel currently displayed in the main view. The mechanism is the
   engine's EXISTING opt-in persistence (`createSnapshotStore(init, { persist })`
   / `defineStore({ persist })`, hand-rolled whole-value JSON to localStorage);
   there is no second mechanism, and every key stays under the `dsh.` prefix.

   The contract, as implemented:

   - **Opt-in, per store.** A store declares `persist: 'dsh.<name>'` for
     whole-value persistence, or `persist: { name, partial }` to store only a
     subset. With a picker the entry holds `partial(state)` and rehydration is
     `{ ...init, ...stored }`, so an excluded field (or a key an older build
     never wrote) keeps its declared default instead of arriving `undefined`.
     A corrupt or non-object entry falls back to `init` and only disables that
     one restore: storage failures (quota, private mode, no localStorage at all
     in a node run) never break the store.
   - **Persisted today:** `dsh.sessions.current` (the open conversation; the
     runtime restores it into the session list, and the list is the authority),
     `dsh.conversation.chat.<scope>` (composer draft/mode per session),
     `dsh.workspace.view.v5`, `dsh.trajectory.duration`, `dsh.layout.panels`
     (sidebar width, details width and whether details is open — a subset:
     widths only), and `dsh.inbox.channel` (the open channel id — a subset: the
     id only, never the server-owned row).
   - **Not persisted, on purpose.** `narrow`, `narrowExpanded` and `portrait`
     are viewport *measurements*: AppFrame re-measures them on every resize and
     `setNarrow`/`setPortrait` drop the manual override when the measurement
     changes, so a stored reading would fight the frame that owns it. The
     layout store's `page` is not persisted either, because the channel page has
     ONE writer: ui-inbox restores the persisted channel id and calls
     `layout.openPage('agent-channel')` in the same step once the server's rows
     are known, so a reload lands on the channel itself instead of painting the
     agent conversation for a frame. A persisted id that no longer resolves
     (cleared, removed, or another person's channel) is dropped and the ordinary
     conversation default stands, with no banner: nothing failed.
   - **The row highlight is derived, never owned.** `InboxState.openAgent` is
     recomputed from `sessions.list.current` on every frame — the same value the
     conversation pane renders — so "the painted conversation" and "the row
     claiming to be current" cannot disagree, including after a reload where the
     runtime restores the selection and no click ever ran.
   - **Client state dies at every login boundary.** It is per-origin browser
     state, so the e-server PIN/profile proxy owns the wipe: logout clears the
     origin's storage and so does the PIN lock screen (`e-server` `24cd5bc`).
     Nothing in the harness needs a profile-aware key for that; a persisted id
     from another person's session simply does not resolve and is dropped.

   Re-apply on an upstream pull: the `PersistOption`/`StoreDeclaration` pair and
   `attachPersistence` in `packages/client/runtime/src/client/contract/store.ts`,
   the `persist` block in `ui-layout/src/client/stores.ts`, and the persisted
   selection store plus `restorePersisted` in `ui-inbox/src/client/` (with the
   restore effect in its `index.ts` that is armed exactly once per load).
16. **Persistence: settings shell + per-conversation disclosure**
   (`ui-settings-general`, `ui-conversation`) — Owen's reload rule, the half
   that owns the modal and disclosure. A reload must land the reader where they
   were, and must not invent a position they were not in. This is the second
   half of entry 15 — same contract, different packages — written in parallel
   with it and kept beside it.

   Two states moved out of component `useState` into the engine's existing
   `persist` option — no second mechanism, no direct `localStorage` calls:

   - **Settings shell** (`settings-shell-store.ts`, root scope, key
     `dsh.settings.shell`): `{ open, sectionId }`. The `sidebar.settings`
     registration now declares `store: createSettingsShellStore`, so the store
     instance rides the standard props seat into `SettingsRoot`.
   - **Plan strip disclosure** (`disclosure-store.ts`, session scope, key
     `dsh.conversation.disclosure.<sessionId>`): `{ planCollapsed }`, declared on
     the session-scoped `conversation.input.dock` entry. The engine suffixes the
     session id, which is what scopes the flag per conversation — a stored value
     for a conversation that no longer exists stays under its own key and is
     unreadable by any other session.

   Two decisions are about what a reload is allowed to do, and both are
   deliberate:

   - **Closed is a remembered value.** `close()` writes `open: false` rather
     than clearing state, so a reload with the modal closed comes back closed
     instead of surprise-reopening it.
   - **`sectionId` survives `close()`.** The last section the reader looked at is
     what a reopen returns to. Before this, closing cleared the active id and a
     reopen silently reset to the first nav row — measured: reopen went from
     `Learn More` to `General`.

   `TodoPanel` became presentational (`collapsed` + `onToggle` props) so the flag
   has exactly one owner; `TodoDock` reads and writes the store.

   Deliberately NOT persisted, each for a measured reason rather than by
   omission:

   - **The Plugins tab id.** Exactly one package registers a
     `settings.plugins.tab` entry (`ui-settings-plugin-inventory`, id `all`), and
     `PluginsSettingsSection` renders a lone page bare with no tablist when
     `rows.length === 1`. Measured in the browser: 0 `[role=tab]` and 0
     `[role=tablist]` inside the settings dialog. A persisted tab id would be a
     key for a control no reader can press.
   - **Effort.** The selection is not client state: it is submitted to the host
     (`select({ provider, model, reasoningEffort })`) and writes no `dsh.*` key —
     measured. Persisting it in localStorage would add a second mechanism beside
     the host's own record.
   - **Tool-card, reasoning, context-injection, compaction disclosures.** The
     tool card's expansion is `useState` in `ui-tool` (`ToolRow.tsx:149`), and
     the chat rows mount by transcript index (`key={i}` in
     `AssistantMarkdown.tsx:66`), so a persisted expansion would re-expand
     whichever row later occupies that index. Component-local until a row
     carries a stable identity.
   - **Goal edit form, jobs popover, deliverables Show-more, plan-mode
     transition/error.** Transient or non-viewing state; restoring any of them
     would restore a stuck transition, a stale error, or an arbitrary cursor.

   Re-apply on an upstream pull: `settings-shell-store.ts` + the `store:` line on
   the `sidebar.settings` registration + `SettingsRoot`'s store reads,
   `disclosure-store.ts` + the `store:` line on the `conversation.input.dock`
   `todo` entry + `TodoPanel`/`TodoDock`. The browser evidence is
   `packages/client/ui-inbox/tests/fixture/reload-probe.mjs` — the BEFORE/AFTER
   of every surface above, with the plan strip measured on two conversations
   seeded as real session logs by `seed-disclosure-sessions.mjs` (the keyless
   fixture calls no model, so a plan has to come from a log; the `?fixture` wire
   client cannot serve this case, its composer is taken over by a resident
   pending question and its only plan strip is the hidden chain-overlay
   fallback).

17. **The channel restore must not race the frame's mount** (`ui-inbox`,
   `ui-layout`) — entry 15's channel half, repaired where the composed app
   actually broke it. Measured in a real Chromium through the composed origin
   (owen profile) after entry 15 was in the bundle: with
   `dsh.inbox.channel = {"channelId":"delta-diana"}` the rows loaded, the
   channel was selected (its row carried `aria-current`, and the open-channel
   poll ran), and `agent-channel-page` was still count 0 while
   `conversation-empty` = 1 stayed painted.

   `restorePersisted` ran and did its own job. What failed was the page write,
   and the composed-only reason is the ORDER of two boots — invisible to a unit
   test whose `ctx.layout` is a bare spy:

   - `ctx.layout` (ui-layout's `LayoutController`) exists from ui-layout's
     apply, but its panel actions exist only once the root entry RENDERS:
     `attachPanels(actions)` runs in the registration's `inject` hook, which the
     renderer calls in the entry's first render
     (`ui-renderer/src/client/scoped-slots.tsx`, `runInject`).
   - The channel list is a network read and can land first. Measured boot: the
     rows wrote at t+48ms, the frame's first render attached at t+110ms.
   - So `openPage` reached `#require()` with `#panels === undefined` and THREW
     ("layout: panel actions not wired"). It threw inside the
     `void channels.restorePersisted(...)` promise, so nothing observed it: the
     selection stayed, the page write was lost.

   The fix is in the layer that owns the wiring. `LayoutController.openPage`
   now holds a request that arrives before the frame mounted (`#pendingPage`)
   and `attachPanels` applies it inside that first render — the frame reads its
   store snapshot after the hook runs, so the first painted frame is already the
   channel and nothing corrects itself a frame later. Being early is no longer a
   failure for this one transition; the gestures (`toggleSidebar`,
   `openDetails`, `closeDetails`) keep their fail-loud contract, because a
   gesture cannot precede the frame. In `ui-inbox` the restore effect now
   subscribes BEFORE reading the rows that are already there, so its two
   triggers are the notification and the state as it stands: a restore that only
   fires while the data happens to arrive under our eyes is not a restore. Both
   invariants hold — armed exactly once per load, so a later rows refresh cannot
   re-navigate the person, and an unresolvable id is dropped silently.

   Evidence, and why the old unit test was not enough: the new
   `ui-inbox/tests/browser-plugin.client.spec.tsx` case boots with ui-layout's
   REAL `LayoutController` and attaches the panels afterwards — the composed
   order — so it fails at the buggy commit (`openPage` never lands) and passes
   now; `ui-layout/tests/service.client.spec.ts` pins the hold-then-apply
   contract and consumed-once behaviour. A fake `{ openPage: vi.fn() }` can
   never be early, which is exactly why the browser found this and the suite did
   not.

   Re-apply on an upstream pull: `#pendingPage` plus `openPage`/`attachPanels`
   in `ui-layout/src/client/service.ts`, and the subscribe-then-read restore
   effect in `ui-inbox/src/client/index.ts`. The composed proof is e-server's
   `tests/harness_inbox_browser.mjs` reload block: conversation restored to
   Darwin, channel restored as the main view when unfolded, folded sidebar still
   folded with the channel still the main view, and the row highlight agreeing
   with the painted surface.
18. **The settings plane is host-backed on every served authority**
   (`ui-settings`, `ui-settings-general`; `bc2970c4af`) — upstream decides
   client-side whether a browser may touch the privileged settings wire: a
   non-loopback page runs the settings scopes in a process-local `memory` mode
   and its Settings panel offers no local-document action. This fork overrides
   both halves: the household reaches the app at `100.100.1.0:8443` through the
   e-server PIN/profile proxy (nginx → e-server `/_dsh` → the harness on
   loopback), the harness runs with `--trusted-host 100.100.1.0
   --trusted-host easter-server.char-istrian.ts.net`, and the Host's own
   privileged-method fence (`packages/client/connection/src/index.ts`, the
   `PRIVILEGED_METHODS` check) accepts those authorities. So `settings.describe`
   answers 200 behind the proxy and the document is shared on purpose: language,
   appearance and the welcome acknowledgement live in it and must reach a
   browser on a phone or a laptop, not only one on this machine.

   The trap that makes upstream's rule wrong here: `connection.isLoopback` is
   `pageLocation === undefined || isLoopbackHostname(pageLocation.hostname)`
   (`packages/client/connection/src/client/index.ts`), and `100.100.1.0` is not
   a loopback hostname. The owner browsing his own machine's settings through
   the proxy therefore reports `isLoopback: false` — gating the settings plane
   (or the "Open configuration file" action) on that signal hides a working
   control from the person the document belongs to. Do not re-introduce the
   gate; a loopback test here is not a capability test.

   What that means in code, and what an upstream pull must restore:

   - `ui-settings`: `new SettingsDescribeMirror(connection.api, 'host')` and
     `SettingsScopeBinder.bind()` passing `'host'`, with no `isLoopback`
     branch. `memory` mode still exists in the mirror and the scope controller
     and is still correct API — this deployment just never selects it.
   - `ui-settings-general`: `apply()` constructs `SettingsDocumentStore`
     unconditionally and registers `settings.action` for every browser. What
     decides whether the action paints is availability, not page authority:
     `SettingsDocumentAction` renders only at `hasDocument`, and a failing
     open keeps it available with a localized error.
   - The three specs that encode upstream's rule were amended to this policy
     rather than deleted: `ui-settings-general/tests/apply.client.spec.ts` >
     'offers the document action off-loopback too, backed by the host document',
     `ui-settings/tests/settings-scope.client.spec.ts` > 'binds a remote browser
     to the host document, not process-local memory', and
     `ui-settings-models/tests/apply.client.spec.ts` > 'off-loopback the
     acknowledgement is written to the host document'. Each cites this entry.

19. **Learn More and Plugins are deleted from Settings, not disabled**
    (`packages/client/ui-settings-learn`, `packages/client/ui-settings-plugins`,
    `packages/client/ui-settings-plugin-inventory`, `packages/host/plugin-inventory`)
    — Owen's words: "Just remove the settings menu side bar, learn more tab, and
    plugins tab entirely." The two tabs are gone with everything that existed
    only to serve them, in one change, so that the Settings modal's only
    remaining `settings.section` registrant is General:

    - `ui-settings-learn` — the `settings.section` entry `learn` (order 5), its
      controller, the `/v1/browser/learn` reader, the section component and its
      dictionary. The tab is not coming back; the e-server route behind it
      (`api/learn_routes.py`, `context/agent-guides.json`) belongs to e-server
      and is deleted there once this bundle no longer calls it. Entry 11 is
      therefore historical: **do not re-apply its four surfaces on an upstream
      pull.**
    - `ui-settings-plugins` — the `settings.section` entry `plugins` (order 15)
      and the read-only chrome that hosted `settings.plugins.tab`. With no
      section owner left, nothing declares that tab slot at runtime. Entry 13 is
      historical in the same way: **do not re-apply it.**
    - `ui-settings-plugin-inventory` — the `settings.plugins.tab` contribution
      `all`, the only registrant of that slot.
    - `packages/host/plugin-inventory` — the read-only Loader projection whose
      single `pluginInventory/list` Remote fed the inventory tab. Nothing else
      read it (checked: no other package, and nothing in e-server, names
      `pluginInventory`, `PluginInventory*` or the package), so the host
      capability goes with its only consumer rather than being left as an RPC
      nobody can call. Its composition row, its `api-remotes` mount and the
      `@deepseek-ai/dsh-host-plugin-inventory` dependency followed it out.

    What an upstream pull must not resurrect: the four packages above, their
    rows in `packages/bundle/web-app/cordis.patch.yml` (`ui-settings-learn`,
    `ui-settings-plugins`, `ui-settings-plugin-inventory`, `plugin-inventory`),
    their entries in `packages/bundle/web-app/package.json`,
    `packages/api/remotes/package.json` and `src/client/index.ts`, their project
    references in `tsconfig.client.json` / `tsconfig.host.json` /
    `packages/api/remotes/tsconfig.client.json`, their `tsconfig.base.json`
    path mappings, their rows in `packages/client/README.md` and
    `packages/host/README.md` (and the `.zh` pair), and their entries in
    `scripts/verify-package-readme-model-experience.ts` and
    `scripts/rescope-vendor.ts`. The generated `client` slot catalogue
    (`pnpm run gen-client-catalog`) drops both occupants and the inventory tab,
    and `docs/config-catalog.md` / `docs/module-graph.md` lose all four packages
    through their own generators.

    **The orphan slot declaration went too, as its own step.** Deleting the
    trailing consumers left `settings.plugins.tab` typed in
    `packages/client/ui-settings/src/client/contract/slots.ts` with no declarer
    and no registrant, and the regenerated catalogue then taught it as
    `declaredBy: 'the runtime itself (built in; always present)'` with zero
    occupants — a slot that throws on register, offered to the next reader and
    to any model that calls `cordis_inspect what:"client"`. The `SlotMap` entry,
    its `SettingsPluginsTabOwnerProps` interface and the matching export in
    `ui-settings/src/client/index.ts` are therefore deleted, along with the
    `settings.plugins.tab` clause in that package's README pair. Regenerating
    the catalogue drops the entry: grepping the generated
    `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` for
    `settings.plugins.tab` returns no match, and `settings.section` now lists
    only `general` and `models` (the models row is the disabled one, unrelated
    to this change). What the shell still carries is `ui-settings-general`'s
    `navIcon` map with a `plugins` branch — that package's nav-rail removal
    owns it.

    Two stale records are left alone on purpose: the recorded probe evidence in
    `packages/client/ui-inbox/tests/fixture/RELOAD-PROBE.md` and its
    `reload-proof.before.json` / `.after.json` measure a past commit and are not
    rewritten; the live `reload-probe.mjs` in that directory no longer names a
    Settings section, it reads the nav rows the build renders and reports them.

    **Layers run:** `pnpm install` (lockfile), `pnpm run build:lib:host` 0,
    `pnpm build` 0 (twice: after the deletions and after the slot-type removal),
    `pnpm run build:lib:client` 0, vitest over every package that remains and
    every package touched (1 pre-existing failure in
    `packages/host/apiproxy/tests/api-proxy-fork.spec.ts`, reproduced unchanged
    at the base commit), `gen-client-catalog` / `gen-config-catalog` /
    `gen-module-graph` regenerated rather than hand-edited with
    `verify-client-catalog` / `verify-config-catalog` / `verify-module-graph`
    green, and a Chromium pass over the keyless web fixture
    (`tests/fixture/start-dsh-fixture.sh`) that opens the Settings dialog at
    1280x800 and 390x844: one nav row (`General`), no `Learn More`, no
    `Plugins`, no tablist, no console error, no failed request. No merge, no
    deploy.
20. **The Language preference row is gone; the dictionaries stay**
   (`packages/client/locale`, `ui-settings` slot prose, web e2e goldens) — the
   owner asked for the Settings Language selector to be removed as broken and
   unsupported. Only the SELECTOR is gone: the locale service, the `t` seat, the
   `zh`/`en` dictionaries and the `<html lang>` sync are untouched, because every
   other package renders its copy through them. A missing key would still fail
   loud in the UI, so translating a new surface is unchanged work.

   **What was actually deleted**, all owned by the locale package itself (it,
   not `ui-settings-general`, registered the row): `LanguageRow.tsx` + its
   `LanguageRow.module.css`, the row's snapshot-mirror store
   (`settings-store.ts`), the row's `settings.locale` dictionaries
   (`locales/settings.ts`, key `language.title`), the
   `ctx.slots.register({ name: 'settings.general.item', id: 'language' })`
   registration together with the store projection, the action-binding face and
   the `LanguageRowInjected`/`LanguageRowState`/`LanguageOptionRow` exports, and
   the `SETTINGS_NS` export plus the `'settings.locale'` entry in the
   `LocaleNamespaceMap` declaration merge. The row's two spec files are deleted,
   not skipped, and `apply.client.spec.ts` now asserts the plugin contributes no
   General row at all. The generated client slot catalogue
   (`pnpm run gen-client-catalog`) drops `client-locale LanguageRow id
   'language'` from the `settings.general.item` occupants, and the slot's own
   doc prose no longer names a locale → Language registrant.

   **What the row did before it was removed** (measured on this build, not
   assumed): on the loopback origin it worked. Switching English → 中文
   translated the visible app — settings dialog title, nav (通用设置/模型/插件),
   the Appearance and busy-Enter rows, the sidebar and its inbox copy — moved
   `<html lang>` from `en` to `zh-CN`, wrote `locale:
  preference: zh` to
   `$DSH_HOME/settings.yaml`, and survived a reload and a second browser on the
   same home; switching back restored English the same way. It is not broken on
   this machine. The honest reason it can still read as broken to its owner is
   the transport: the browser half writes the preference through the privileged
   settings wire, so a page that cannot reach the Host document keeps a
   process-local choice that a reload discards (the `memory` fallback in
   `ui-settings`, see entry 18). Either way the removal is the owner's call.

   **Consequences worth keeping on an upstream pull:**

   - The plugin still binds the durable `locale` settings namespace and still
     adopts `locale.preference`, so a stored preference keeps deciding the
     surface language — it is now settable only by editing `settings.yaml`
     (delete the key to hand the choice back to the browser). Keep that
     adoption; it is what makes a household-wide language choice possible
     without a per-browser selector.
   - `LocaleRuntime.setLocale()` remains the service-level write entry and stays
     covered by `locale.client.spec.ts`; no shipped surface calls it.
   - `apps/web/tests/settings-chrome.e2e.ts` no longer clicks a language pill:
     the scenario asserts the row's absence and that a seeded
     `locale: preference: en` home still governs the surface across a reload,
     and the dialog goldens (`dialog.expected.md`, `dialog-en.expected.md`) are
     refreshed without the row.

21. **The Settings panel is its section: no nav rail, no document action**
    (`ui-settings-general`, `ui-settings`) — the other half of Owen's words above:
    "Just remove the settings menu side bar ... also remove the 'open configuration
    file' button in the top right." Entry 19 deleted the two tabs; this deleted the
    machinery that existed to switch between tabs and the action that sat beside
    Close.

    - **The rail is gone, and the panel is one column.** `SettingsRoot` renders a
      title row (the `settings.header` seat text plus the shell-owned Close) over
      the section, which now takes the panel's whole inner width. Measured in
      Chromium over the assembled web scaffold, on the tree that also has the
      Language row removed, at 1280x800: panel 800x752 at x=240, the options box
      the full panel width and the section row 752 wide at x=264 — the whole
      content box (`800 - 2*24`), where the old layout began the content column at
      `188 + 24` and had 564px to draw in. At 390x844: panel 342x796 at x=24, row
      294 wide at x=48. No `<nav>`, no tablist, one header button, no horizontal
      overflow, and `.options` does not scroll at either shape (696/696 and
      740/740 px). The rendered copy is the title, Close, Appearance (three cubes)
      and the busy-Enter row.
    - **No section id is hardcoded.** The shell renders the first ordered
      `settings.section` registration, passed through the scoped slot's `only`
      filter. With one section there is nothing to navigate; a second
      registration renders nowhere rather than appearing as a tab, and the
      package README says so. Section `label`s are no longer projected (nothing
      renders them), so General registers none and `resolveSlotLabel` left the
      shell.
    - **`settings.action` is deleted, not hidden.** The slot type and its
      `SettingsHeaderOwnerProps` render site, `SettingsDocumentAction`, its module
      CSS, `SettingsDocumentStore` and its spec are gone; the dialog's header
      renders no slot at all and holds exactly one button (Close). `inject`
      shrank to `['slots', 'locale']`, and the `openDocument` /
      `openDocument.error` copy plus `general.nav` left `locales.ts`. The host RPC
      `settings.openDocument` still exists in `api-*`/`apiproxy` — only the client
      control that called it is gone, and a replay run asserts no such request is
      ever made.
    - **`dsh.settings.shell` keeps only `{ open }`.** `sectionId`, `select()` and
      `openSection()` are deleted from the store, and `persist` now declares the
      `open` subset, so a legacy `{open, sectionId}` entry rehydrates with its
      section half ignored and is rewritten without it on the reader's next open
      or close. The reload rule entry 16 established still holds, measured through
      the assembled app: open stays open, closed stays closed (`{"open":true}` →
      open dialog after reload; `{"open":false}` → 0 dialogs, no console warning).
    - **The onboarding seat names no section.** `openSection(id)` became
      `openSettings()`; the two `ui-settings-models` specs that construct those
      props were updated rather than deleted.
    - **The e2e lane.** `apps/web/tests/settings-chrome.e2e.ts` now asserts the
      absent nav/tabs/section buttons, the single header button, and the absent
      `settings.openDocument` request, and its two dialog goldens were refreshed
      from the live panel (`plugins.expected.md` left with the Plugins section).
      Four assertions that anchored on removed surfaces are re-pointed rather than
      left red: the `Workspace Write` row (entry 12), the `语言`/`中文` Language row
      (the Language-row removal), a trigger click after a reload that happened
      with the panel open (now asserts the panel came back open instead), and the
      two English/French browser scenarios that waited on the `General` nav button
      and now anchor on the `Appearance` row. `npx vitest run --config
      vitest.web.config.ts apps/web/tests/settings-chrome.e2e.ts` (replay) is 8/9;
      the remaining failure, `stores Permission as the default for future
      sessions`, is red identically at the base commit (the fork pins
      `defaultPreset: danger-full-access` and the scenario still expects
      `workspace-write`) and drives a Permission control that no longer exists, so
      it belongs to entry 12, not here.

    **What an upstream pull must not resurrect:** the `<nav>` rail and its
    per-section glyph map, the `settings.action` slot and any
    open-configuration-file control, `sectionId`/`select`/`openSection` in the
    shell store, and `openSection(id)` on the onboarding seat. Upstream's own
    tests for the removed surfaces are deleted here rather than skipped; an
    upstream re-add will have to delete them again deliberately.

    **Layers run:** `pnpm run build:lib:host` 0, `npx tsc -b tsconfig.client.json`
    0, `pnpm build` 0 in a warm worktree (202 client artifacts), vitest over
    `ui-settings-general`, `ui-settings`, `ui-settings-models`, `locale`,
    `ui-theme`, `ui-conversation` and `cordis-client-runner` green apart from the
    pre-existing `ui-theme` remote-browser case that is red on master too,
    `gen-client-catalog` regenerated (not hand-edited) with `verify-client-catalog`
    / `verify-module-graph` / `verify-config-catalog` / `verify-client-packages`
    green and `verify-md-links` / `verify-export-jsdoc` green, one mutation check
    (a `<nav>` put back makes the two new shell assertions fail: the button list
    becomes `['General','Close']`), and a Chromium pass over the keyless web
    scaffold at 1280x800 and 390x844 for geometry, screenshots, console tripwire
    and the reload rule. Not run here: the composed e-server origin (the
    coordinator's own gate) and any deploy. No merge, no deploy.
22. **No per-message branch and no good/bad response controls**
   (`ui-conversation`, `ui-message-feedback` deleted; `24362c8cfe`) — Owen:
   "remove the 'branch into new conversation' option from each message" and
   "remove the 'good response bad response' options from each message". Both
   are deleted, not hidden, and both went in one pass because they shared the
   finalized assistant message's IconActions row.

   - **Branch.** `MessageIconActions` is copy plus the clock. Gone with it:
     the `onBranch`/`branchUnavailable` props and the `extraActions` strip,
     the `IconBranchOutline16` import, the tooltip copy swap, the hidden
     `aria-describedby` reason node, the `.action[data-unavailable]` and
     `.visuallyHidden` rules in `MessageIconActions.module.css`, the
     `data.branchUnavailable || hasLaterChatNode` computation in
     `TurnTailNodeView`, the tail-eligibility scan in
     `conversation-nodes/turn-tail.ts`, `TurnTailChatData.branchUnavailable`,
     the `forkAt` owner-injected member (`ChatNodeOwnerProps`,
     `ChatViewInjected`, `ChatNodeSeat`, `ChatView`) and the `forkAt` factory
     in `apply.ts`, plus `message.branch` / `message.branchUnavailable` in
     both dictionaries.
   - **Feedback.** `packages/client/ui-message-feedback` is deleted whole:
     its composition row in `packages/bundle/web-app/cordis.patch.yml`, the
     web-app `package.json` dependency, the `tsconfig.client.json` project,
     the `tsconfig.base.json` path mapping, its
     `verify-package-readme-model-experience` entry and its regenerated
     catalogue rows. The slot it occupied, `conversation.chat.assistant-actions`,
     had exactly one registrant, so the slot declaration, its
     `AssistantActionOwnerProps` and the `children` authorization on the
     `turn-tail` renderer key are deleted too: the row keeps no empty wrapper,
     no divider and no gap where the thumbs and the branch icon were, and
     `TurnTailNodeView` skips the render site entirely.
   - **Kept on purpose, pending a separate decision.** The
     `message-feedback` host row, `packages/feedback/message-feedback` and its
     generated `messageFeedback` Remote still load and are still driven end to
     end by `apps/web/tests/message-feedback-protocol.snapshot.ts`; no browser
     package calls `ctx.remote.messageFeedback`. The runtime's `sessions.fork`
     is still called by the workspace session-row action
     (`packages/client/ui-workspace/src/client/index.ts`) — only the message
     row lost its caller.
   - **Re-apply on an upstream pull.** Upstream still ships the branch action
     and the feedback strip, so restoring this state means deleting the same
     files and hunks again; `FORK-NOTES` entry 18's settings plane and this
     entry do not interact.
   - **Browser evidence (1280x800, one settled assistant message).** Row at
     base: Copy → Good response → Bad response → Branch into a new
     conversation → clock, 28px items, 10px gaps, `scrollWidth == clientWidth
     == 754`, zero separators, clock `7/25 06:08 · Ran for 1s · TTFT 0.5s ·
     131 tok/s`. After: Copy → clock, same 10px gap, same 754px row, one line,
     zero separators, no thumbs, no branch, clock unchanged. Measured with
     `playwright` + `apps/web/tests/scaffold.ts` (`launchWebScaffold`) in a
     throwaway spec, twice: once at the base commit, once after the change.
   - **Known pre-existing breakage this entry does not fix.** The household
     `ui-inbox` replaced `ui-workspace` as the sidebar, and its conversation
     list needs the e-server origin, so every `apps/web/tests` scenario that
     opens a session through a `[role="treeitem"]` fails at base too (11 of 15
     across `stats-paged-history` and `seeded-history`). For the row
     measurement the sidebar was swapped back with a throwaway overlay
     (`ui-inbox` disabled, `ui-workspace` enabled); the committed aria goldens
     under `apps/web/tests/snapshots/` still name the two removed controls and
     cannot be re-recorded until that composition question is answered.

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
