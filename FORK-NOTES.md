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
23. **Locale dictionary parity floor follows the fork's shipped corpus**
   (`scripts/locale-dictionary-parity.spec.ts`) — upstream asserts
   `comparedPairs > 25`, a discovery floor rather than a key-parity rule; key
   parity is the separate `problems` assertion, which stays empty. Five
   zh/en pairs left this fork with their UI and their namespaces:
   `ui-settings-learn`, `ui-settings-plugins`, `ui-settings-plugin-inventory`
   and `ui-message-feedback` (each deleted whole), and
   `packages/client/locale/src/locales/settings.ts`, the `settings.locale`
   `language.title` pair that left with the settings Language row
   (`1698de83a4`). The shipped count went 30 → 25, so the constant is now a
   documented `SHIPPED_PAIR_FLOOR = 25` compared with `toBeGreaterThanOrEqual`
   — zero slack, and every discovered pair is verified key-symmetric in both
   directions. Re-apply after an upstream pull, which will restore the larger
   corpus and the stricter comparison.

24. **The chat transcript has no "Load earlier" and never grows**
   (`ui-conversation`) — Owen: "as the user begins to scroll up in chat there
   is a 'Load earlier' indicator, remove this feature, so the client side
   visible messages are only ever so recent." The control is deleted, not
   hidden, and the paging path behind it is deleted with it. A session still
   opens on its most recent page (`PAGE_MESSAGES = 50` unchanged), so the
   transcript is the window it fetched: a reader who scrolls up reaches its
   oldest row and stops there. The agent's view of history is untouched — the
   host still reads the whole log, and every whole-log projection (stats,
   tokens, context) was already independent of the loaded window.

   - **Removed.** `ChatView`'s `hasMore`/`loadingOlder` reads, the "Load
     earlier" button and its `.older` CSS block, the scroll-anchor bookkeeping
     that existed only to keep the viewport steady while an earlier page was
     prepended (`PagingAnchor`, `anchorRef`, the reset effect, the prepend
     branch of the layout effect, `firstSeqRef`, `loadOlderAnchored`),
     `IConversation.loadOlder` and its implementation in `service.ts`,
     `ChatViewInjected.loadOlder` in `contract/slots.ts`, the `apply.ts`
     wiring and the `scopedConversation` resolution that only fed it, and
     `chat.loadOlder` in both dictionaries. The scroll-position memory
     (`chatScroll`) stays: `pagingAnchor`/`flowTop`/`anchorElement` are shared
     with it and a view-tab round trip still restores the reader's row.
   - **Kept on purpose, and it is the remaining paging surface.**
     `Session.loadOlder`, `hasMore` and `loadingOlder` stay in
     `packages/client/runtime`, together with `PAGE_MESSAGES` and the
     tail-page open. They are not dead: the `conversation.view` target
     `ui-trajectory` reads all three (`TrajectoryView`'s "Load earlier
     history", `index.ts`'s injected `loadOlder`), and the generated
     `cordis-client-runner` client catalogue publishes them. Deleting them
     here would have broken that tab, so this entry removes the chat path only;
     if the household wants no paging anywhere, `ui-trajectory` needs its own
     change first.
   - **Tests.** `ui-conversation` 467 → 469 unit tests, all green. Deleted the
     four specs that only proved paging (the prepend-anchor case, the
     back-to-bottom-cancels-an-anchor case, the anchor half of the
     prepend/force-scroll case, and the button's busy-label case); re-pointed
     the trailing-user force-scroll case and the `service`/`apply` route specs
     that used `loadOlder` as a seam. Added: the control is absent even when
     the snapshot reports older history; a 50-row window renders from its own
     boundary with nothing above it; scrolling to the top issues nothing; and
     an assembled-scene case that scrolls a partial window to the top and
     observes zero calls on a proxy session face. Mutation-checked by putting
     the button back: the absence assertions fail.
   - **Web lanes, edited but not run.** `apps/web/tests` had five copies of the
     old click. `chat-scroll-contract.e2e.ts` now records every
     `session.history` request that carries `beforeSeq` and asserts the list
     stays empty while a stream appends and the reader parks at the window's
     head; its restore scenario scrolls the seeded window instead of paging it
     first. `stats-paged-history.e2e.ts` scrolls to the top and asserts the
     older marker never appears, no control exists, the strip does not move and
     the window mounts `TURNS - 3` turn-tail footers (50 messages of 56).
     `complex-history.perf.ts` lost its chat expand loop, its
     `expanded-history-500-plus-8` scenario (it only existed to click the
     button 500 messages deep) and its `historyPages` metric; the
     workspace/history scenario still measures the trajectory rows, which do
     page. These suites are already red at base for the `ui-inbox` composition
     reason recorded in entry 22 — reproduced here: the seeded session never
     appears in a `[role="treeitem"]` row, the page shows the household
     "Select an Agent or Channel" region instead, so nothing in this change was
     executed in a browser. `apps/web/tests/snapshots/stats-paged-history/ui.expected.md`
     records the previously paged transcript (all 28 turns, captured after the
     click) and now mismatches: it needs `npm run test:web:refresh` once that
     composition question is answered, which is also when this scenario's new
     assertions become executable.

25. **Every failing test is classified: fork policy or environment, never
    "known red"** — the suite carried 14 red files nobody had justified, which
    is exactly how a real regression hides. Each of the 23 failing tests at
    `7c797cea12` is now exactly one of two of the fork's three allowed kinds —
    **FORK CONTRADICTION** (the test asserts upstream policy this fork decided
    against: amended to assert what ships, with the deciding commit cited, and
    upstream's own case kept wherever it still holds) or **ENVIRONMENT** (the
    case cannot arise in this process: guarded with `test.skip(condition,
    reason)`, so a verbose run prints `↓ <test> [reason]` and the case still
    runs where the condition holds). No third kind was needed: none of the 23
    was OUR REGRESSION. There is no "known failure" bucket, and nothing was
    deleted to turn the suite green.

    Measured starting point, first-hand in this checkout: a detached worktree at
    `7c797cea12` with `node_modules` hardlinked from the live checkout, then
    `npx vitest run` → `Test Files 14 failed | 823 passed | 11 skipped (848)`,
    `Tests 23 failed | 14013 passed | 119 skipped (14155)`, exit 1, plus three
    uncaught `SyntaxError: Unexpected end of JSON input` from
    `packages/sdk/server/tests/{server,plugin-apply}.spec.ts` (not among the 23;
    fixed in C below).

    | Test (as it failed at `7c797cea12`) | Class | Action | Evidence |
    | --- | --- | --- | --- |
    | `connection/tests/node-half.host.spec.ts` › `pins privileged methods to loopback even for a declared trusted authority` | FORK CONTRADICTION | Amended to `reaches privileged methods from a declared trusted authority and still refuses an undeclared one`: a declared authority reaches every privileged method (the empty proxy answers the carrier's 404, i.e. the fence passed), `harness.other` still gets 403 `forbidden` on all of them, and loopback still reaches them. | `1ed4447cc6` (FORK-NOTES 1); product: `connection/src/index.ts`'s privileged guard is the same `isTrustedApiRequest(request, trustedHosts)` call the ordinary `/api` route makes — the privileged set reuses the declared list, it does not add a loopback rule |
    | same file › `answers a declared LAN authority with 403 on every configuration method, over real HTTP` | FORK CONTRADICTION | Amended to the same three claims through a real `IncomingMessage` and a real parsed `Host` header on a real server: declared → 404 per method, undeclared → 403 per method. | `1ed4447cc6`; the case's `serve()`/`call()` fixtures drive the deployed HTTP path, not a hand-built request object |
    | `ui-theme/tests/apply.client.spec.ts` › `loads Host settings at boot, refreshes its namespace, and keeps remote browsers process-local` | FORK CONTRADICTION | Amended to `…binds remote browsers to the same document`: an off-loopback browser reads the Host document at boot (`describe` called), writes its switch through it (`mutate` called), and the preference lands in `getTheme()`. | `bc2970c4af` replaced `connection.isLoopback ? 'host' : 'memory'` with `'host'` in `ui-settings/src/client/index.ts`; `memory` stays valid API, this deployment never selects it. The household browses `100.100.1.0:8443`, so `isLoopback` is false for the owner's own browser |
    | `ui-trajectory/tests/views.client.spec.tsx` › `renders two tabs, defaults to chat, and switches to the trajectory ledger`; `opens a local record inspector and switches payload tabs without opening chat details`; `labels a standalone compaction as between-turn work in the ledger and inspector`; `activates only the selected standalone compaction section`; `dragging the overview focuses overlapping records without filtering the ledger`; `clicking a timeline block clears the range, selects the record, and opens its inspector`; `empty window keeps the toolbar and reports no timing data` (7) | FORK CONTRADICTION | Amended to mount the one conversation shape whose header this fork renders — the read-only subagent transcript (`mountTranscript`) — so all seven behaviours (ledger rows, inspector, compaction sections, overview drag, timeline click, empty window) still run; plus one new case, `renders no tab ring inside an inbox conversation, where the header is absent`, pinning the fork's other half. | `1964411d9e` + FORK-NOTES 8; `ui-conversation/src/client/skeleton/ConversationSession.tsx:79` is `if (!readOnly) return null`, where `readOnly = Boolean(session.subagent) \|\| summary.origin === 'subagent'`; verdict and composed-surface evidence below |
    | `host/apiproxy/tests/api-proxy-fork.spec.ts` › `installs the latest logged model selection before the child can run` | FORK CONTRADICTION | Assertion unchanged; both agent doubles now carry `options: {}`. Product untouched. | `cbb64017cb` made prompt assembly write the selected provider/model into `agent.options` (`model-selection.ts:69` threw `TypeError: Cannot convert undefined or null to object` on the double). A real agent always has it: `AgentLoop`'s constructor takes `options`, defaulting to `{}` |
    | `scripts/locale-dictionary-parity.spec.ts` › `declares the same keys in zh and en, so the single fallback locale always resolves` | FORK CONTRADICTION | Already amended on master by the docs sweep as `SHIPPED_PAIR_FLOOR = 25` with `toBeGreaterThanOrEqual`; this branch keeps master's version verbatim and drops its own duplicate hunk (resolved as an identical-content conflict). Parity itself was never the failure: `problems` was `[]` — only the stale `> 25` floor failed, five pairs below upstream's corpus. | master `ab0ba7688e`, FORK-NOTES 23; `1698de83a4`, `24362c8cfe` and FORK-NOTES 19/20/22 name the five deleted pairs and their registrants |
    | `context/agent-instructions/tests/agent-instructions.spec.ts` › `skips a file that becomes unreadable after discovery without failing the request` | ENVIRONMENT | Guarded: skips with `this process runs as root: it reads the 0o000 instruction file, so the unreadable-after-discovery case is unobservable`. | root: `↓ … [reason]`; uid 1000: `✓` unskipped (transcript below) |
    | `settings/settings-file/tests/local.spec.ts` › `fails loud at boot when the document exists but is unreadable` | ENVIRONMENT | Guarded, reason `…reads a 0o000 document…`. | as above |
    | `settings/settings-file/tests/concurrency.spec.ts` › `surfaces a non-contention lock failure as the write error` | ENVIRONMENT | Guarded, reason `…writes into a 0o500 directory…`. | as above |
    | `shell/bash-sandbox/tests/sandbox.spec.ts` › `reports a real permission failure as a sandbox denial with the mode it ran under` | ENVIRONMENT | Guarded, reason `…writes into a 0o555 directory, so no denial evidence exists`. | as above |
    | `storage/storage-sqlite/tests/sqlite-backend.spec.ts` › `propagates filesystem errors other than an existing database file` | ENVIRONMENT | Guarded, reason `…creates the database inside a 0o500 directory, so EACCES cannot arise`. | as above |
    | `subagent/subagent-acp/tests/subagent-acp.spec.ts` › `rejects a config cwd directory without search permission at load` | ENVIRONMENT | Guarded, reason `…the search bit does not bind it…`. | as above |
    | `subagent/subagent/tests/out-of-process.spec.ts` › `rejects a directory without search permission` | ENVIRONMENT | Guarded, same reason. | as above |
    | `subagent/subagent-claude-code/tests/real-product.spec.ts` › `maps a real SDK max-turns result to safe query-run facts`; `runs two named instances concurrently and unloads one without revoking its run`; `runs an explicitly selected bypass write in the isolated workspace` (3) | ENVIRONMENT | Guarded with one shared reason, measured against the shipped binary: `--dangerously-skip-permissions cannot be used with root/sudo privileges for security reasons`. The CLI exits 1 before opening a stream, so every `bypassPermissions` scenario is unobservable as root. | `$ <sdk>/claude --print --dangerously-skip-permissions hi` prints that refusal; uid 1000: all three `✓` unskipped, plus the file's other five cases |
    | `shell/bash-sandbox/tests/partial-landlock.spec.ts` › `keeps a real malformed executable ordinary across no-shebang spawn behavior` | ENVIRONMENT | **Measured rather than skipped.** The host-dependent constant is gone: the expected exit status is taken from an unconfined `spawnSync()` of the same file, so the case runs everywhere instead of hiding. The sandbox facts it exists to prove — an ordinary outcome, no denial, no runner-failure attribution — are unchanged and still asserted for both the foreground run and the background task. | The pinned `127` was one shell's behaviour: the no-shebang fallback hands the file's text to `/bin/sh`, and here that is bash with the llvm `not` utility on PATH, which turns the unknown command into exit `1`. Measuring keeps the case honest on both kinds of host |

    **Why the seven ui-trajectory cases are a contradiction and not a
    retirement (§5).** The `conversation.view` tab ring lives in
    `ConversationSessionHeader`, and that component returns `null` for every
    conversation that is not a read-only subagent transcript
    (`ConversationSession.tsx:79`) — the household sidebar is an inbox of one
    persistent conversation per agent, so the title row, the tabs, the utilities
    and the mode label are gone, which is what the spike measured as
    `role=tab` count 0. The view is reachable nonetheless: `ui-subagent` is
    composed in the web app (`packages/bundle/web-app/cordis.patch.yml`), its
    catalog action lists a conversation's subagents, and `openChild({ parentSessionId,
    childSessionId, mode })` navigates to that child transcript
    (`SubagentCatalogAction.tsx`), where `readOnly` is true and the header — with
    the Chat/Trajectory tabs — renders. `ui-trajectory` is a composed row in the
    same file, so the trajectory view is a live surface of this deployment, and
    with it the trajectory's own "Load earlier history", which master's chat
    paging removal deliberately kept alive (`Session.loadOlder`, `hasMore`,
    `loadingOlder`: FORK-NOTES 24). So the seven tests were wrong about *which*
    surface carries the ring, not about behaviour that no longer exists; they are
    re-pointed at the surface that exists and a new case pins the absence in an
    inbox conversation. **Validation limit, stated plainly:** this rests on the
    composition files plus the unit mount, not a recorded browser run — the
    `apps/web` lanes are red at base for the unrelated `ui-inbox` composition
    reason in FORK-NOTES 22, and a targeted browser run would have measured that
    pre-existing breakage rather than this change.

    **The ENVIRONMENT guards were verified where the condition holds.** A second
    checkout (same commit, `node_modules` hardlinked, tree owned by uid 1000) was
    run as `runuser -u owen` over the guarded files: `Test Files 37 passed (37)`,
    `Tests 946 passed (946)`, zero skipped — all ten guarded cases `✓`
    unskipped, including `fails loud at boot when the document exists but is
    unreadable`, `rejects a directory without search permission`, the sqlite
    `EACCES` case, the bash-sandbox denial, and all three Claude Code
    `bypassPermissions` cases. So the guards suppress nothing that works; they
    convert a red line into a stated skip in exactly the process where the
    premise cannot exist. (The copy is a plain filesystem copy because `/tmp` is
    a separate filesystem and hardlinking across it fails; ownership was changed
    on the copy only, never on a hardlinked inode.)

    **C. Fixed, outside the 23 — the same contradiction shape in a double.**
    `packages/sdk/server/tests/{server,plugin-apply}.spec.ts` parsed every
    request body as a completion payload, and the fork's DeepSeek route also
    fetches the provider's bodyless `GET /models` listing (`7fe84a0c7b`, entry
    6); the parse threw inside an event emission and surfaced as an uncaught
    exception that exited the run 1 even though every test in both files passed.
    Both doubles now answer that request with `{"object":"list","data":[]}` (the
    adapter's "no information": the built-in catalog stands) and record only POST
    payloads.

    **Result on this branch** (rebased onto master `2defc254b5`):
    `npx vitest run` → `Test Files 843 passed | 9 skipped (852)`,
    `Tests 14058 passed | 125 skipped (14183)`, 0 failed, exit 0. The skips are
    the pre-existing platform/engine-conditional ones plus the ten guards above;
    a verbose run names each with its reason. Gates: `pnpm typecheck` 0,
    `pnpm build` 0 (warm tree), `node scripts/verify-deployment-build.ts` →
    `deployment build: current source and browser artifacts agree`, 0, and
    `pnpm doc-sync` 28/28 (0 failed).

    **What an upstream pull must not resurrect:** loopback-only privileged
    methods, a non-loopback `memory` settings scope, a conversation header for
    ordinary sessions, an agent double without `options`, a hardcoded
    pair-count floor, and a pinned shell exit status. **What it must keep:** the
    `test.skip(condition, reason)` guards — deleting them turns a stated skip
    back into a red line everyone learns to ignore.

Everything else should ship as **plugins**, which stay upstream-agnostic and
are the candidates for open-sourcing.

26. **Reaction notes: a log-only event kind the model reads and nothing else
    shows** (`core/session`, `host/apiproxy`; ticket `f1bdaed3`) — Owen's
   reaction feature needs a durable record of "a person reacted 👍 to that
   message" that is invisible in the transcript, excluded from compaction, and
   yet present in the model's next request. The spike
   (`feat/react-note-spike`, `9d0684d166`) measured that no such carrier exists:
   the transcript-invisible carrier is also model-invisible
   (`deriveEventMessage` is a closed switch over three surface types), the only
   model-visible carrier is a `user/message` surface event which leaks into
   both the transcript and the compaction checkpoint, and **nothing in the repo
   could write the envelope's `ignorable` marker**, so appending a new kind
   bricked the session on the next load with `SessionFormatUnsupportedError`.

   Four hunks, all of them fork-only until upstream grows equivalent seams:

   - **The event kind** (`packages/core/session/src/types.ts`):
     `ReactionNoteEventData` (`{targetSeq, emoji, actor, action}`) and the
     `'reaction/note': ReactionNoteEventData` member of `SessionEventMap`. It is
     declared in CORE, not by a plugin that merges the map, because the model
     projection lives in core and there is no per-kind registration seam there —
     a plugin-declared kind could never be projected.
   - **The envelope capability** (`types.ts` + `Session.append` in
     `index.ts`): `EnvelopeIntent { ignorable?: true }` as the third argument of
     a log-only append (`[opts?: EnvelopeIntent]` in place of the empty rest
     tuple), written as `ignorable: true` on the envelope. `true` is the only
     legal value, and the marker is rejected on a surface-eligible type: a
     surface event is reconstructed history, so a reader that skips an
     unrecognized one would silently shorten the model's conversation.
     This is the brick fix — a build that predates the kind now skips the note
     instead of refusing the whole log.
   - **The projection** (`packages/core/session/src/surface.ts`):
     `isModelNoteEvent` plus a `case 'reaction/note'` in `deriveEventMessage`
     rendering a user-role message with `id: 'reaction-note-<seq>'` (the fold
     re-runs on replay, resume and compaction, so the id is derived from the
     log, never from a clock), `source: { kind: 'plugin', plugin: 'react-note' }`,
     and one line naming the act, the actor, the glyph and the target seq. The
     message is frozen locally (`freezeSynthesized`) rather than with
     `freezeMessage` from `@deepseek-ai/dsh-llm`: `surface.ts` is the
     browser-safe, value-import-free subpath, and a plugin value import there is
     exactly what the client bundle purity gate rejects (it failed the build
     until this was local).
   - **The fold** (`Session.deriveMessages` in `index.ts`): interleave, and
     live only while the target does. `deriveMessages` walked surface nodes only,
     and a log-only note is not a surface node — so the projection case alone
     reaches nobody. The first cut appended every note AFTER the surface segment,
     which pinned each note to the tail of every later request forever; Owen's
     rule retires that: once the message leaves the context, so should the
     reaction to it. So a note now projects AT ITS LOG POSITION — just before the
     first current surface node whose seq is greater, with any leftover note
     after the last node — and ONLY while its `targetSeq` is still a current
     surface node, i.e. still in `foldSurface`'s `nodes`. A compaction `replace`
     that shadows the target drops the note from the derivation by the same
     stroke that drops the message, which is the whole point; the shadowed-seq
     bookkeeping, the surface order of the replacement copy and the log itself
     are untouched. The lifetime is a PURE FUNCTION OF THE LOG — the `surfaceOp`
     markers plus the note's own `targetSeq`, never a clock, a counter or the
     client's reaction map — so replay, cold resume and a post-compaction rebuild
     derive the identical array. The cache keeps its incremental path (an
     appended event's seq exceeds every already-derived entry's, so tail-append
     preserves the interleave order) and its `replaceGeneration` rebuild;
     `derivedGeneration` is seeded to `-1` so even a replayed log takes the
     rebuild path a compacted one takes.
   - **The wire** (`packages/host/apiproxy`): `session.react` — name, doc,
     schema pair, `rpc-map` row, `fetch/handler` route, `fetch/client` face and
     the `api-proxy` implementation, following `session.rename` (also a
     log-only append). Payload `{sessionId, targetSeq, emoji, action?, actor?}`
     (`action` defaults to `'added'`, `actor` to `'user'`); return `{seq}`; new
     error code `target-not-valid` (`{sessionId, targetSeq}`) for a target that
     is not an append-origin message, appended nothing; cold sessions resume
     through the shared `agentFor` path, and subagents answer `agent-busy` as
     every other unary does. The event vocabulary is generated —
     `npm run gen-persistence-catalog` rewrote `known-event-types.ts` and
     `docs/persistence-catalog.md`, and `verify-persistence-catalog` gates it.

   - **What stays free, and why a test pins it.** A log-only event is dropped by
     the client node registry because no Definition claims it (the fallback
     matches append-surface events only), and it never enters the surface spans
     that `compaction-basic` folds — so no transcript row and no summarisation.
     Both are properties of someone else's default, so they are pinned rather
     than assumed: `packages/client/ui-conversation/tests/reaction-note-transcript.client.spec.ts`
     asserts the chat snapshot is byte-identical with and without a note and
     that no Definition (fallback included) matches one, and
     `packages/core/session/tests/reaction-note.spec.ts` asserts the note is
     absent from `foldSurface`, from every shadowed span, and from anything
     `deriveEventMessage` would hand a summariser.
   - **Re-apply on an upstream pull.** The projection hunks are gone for good
     (see the final rule below): a note has no model projection to re-home. If
     upstream adds its own envelope-intent argument to `Session.append`, keep
     theirs and drop ours; if it ships a plugin seam for log-only events, mount
     the note kind there instead of in `SessionEventMap`. `npm run
     gen-persistence-catalog` regenerates the generated pair either way. The
     client half of the feature is entry 28, and this note owns only the log,
     the wire and the UI projection; the fork has no other consumer of the kind.
   - **Measured, not asserted** (`apps/web/tests/fixture/react-note/`, the real
     built harness with an isolated `DSH_HOME` and a recording mock provider):
     one `session.react` appends exactly `{"reaction/note": 1}`, writes the
     marker, starts no turn or step, makes no model request, generates no title,
     writes no goal/retry/command/queue record, leaves the agent idle with an
     empty inbox and the surface unchanged; a `/compact` whose span (7–55) spans
     the note at seq 23 puts no reaction text in the summarisation request or in
     the durable checkpoint; and a real restart of the same build on the same
     `DSH_HOME` reopens the conversation, keeps the note with its marker, and
     accepts a second note on the resumed cold session.

     **Corrected after the interleave change (entry 26, ticket `781d05ae`).**
     That fixture run also measured the note arriving at "index 6 of 7 — last,
     user role" of the next request, and that number was the old rule showing
     through: it is now the note's LOG POSITION, not the tail, so any note
     reacted to before a later message arrives ahead of that message instead of
     behind it. The fixture was **not** re-run for this change (it drives a built
     harness, and nothing was built), so no new index is quoted here; the rule it
     used to pin is now pinned by unit tests instead —
     `packages/core/session/tests/reaction-note.spec.ts` (a prompt appended after
     a note lands AFTER it; a replacement that shadows the target drops the note;
     a replacement that spares it keeps the note interleaved; live and replayed
     derivations agree) and `packages/session/session-persistence-jsonl/tests/reaction-note-restart.spec.ts`
     (a dropped note is still in the stored log after a restart and still absent
     from the re-derived history).

     **Final rule (entry 26, ticket `52d81c28`): reactions leave the prompt.**
     The interleave above fixed the wrong half. It stopped notes being pinned to
     the tail, but it made each note land AT ITS LOG POSITION — so reacting to a
     message several turns old INSERTED text into the middle of the array
     `packages/core/agent-loop` hands the provider
     (`packages/core/agent-loop/src/agent.ts`), invalidating the prompt cache
     from that point on, every time somebody reacts. Tail-pinning cost tokens;
     interleaving costs the cache; both were wrong for the same reason: a
     reaction is a UI signal the model never needs. So the model-facing half is
     DELETED, not repaired:

     - `Session.deriveMessages()` walks surface nodes only. There is no
       interleave pass, no `derivedNodeSeqs` set, no `derivedLogSeq` walk, no
       `deriveLogEntry` and no `projectNote`; the cache is
       `derivedNodes` + `replaceGeneration` again, so a call still costs
       O(new events) and a `replace` still rebuilds. Appending a reaction to a
       message at any log position leaves the returned array ELEMENT-FOR-ELEMENT
       IDENTICAL (same length, `toEqual`, and every element `toBe` its old
       self) — the property `packages/core/session/tests/reaction-note.spec.ts`
       now asserts as the prompt-cache guarantee instead of assuming it.
     - `deriveEventMessage` has no `case 'reaction/note'`, so a note projects to
       `null` for every consumer of the per-node rule — this session's
       derivation, a compaction span, the token meter, an external replay. The
       text renderer (`reactionNoteText`) and its local `freezeSynthesized` went
       with it: the harness no longer speaks about reactions at all. The payload
       stays `{targetSeq, emoji, actor, action}`, which is what the UI badge
       draws.
     - `isModelNoteEvent` was a name that asserted the false half, so it is
       `isReactionNoteEvent` (exported from `surface.ts` and the package index).
     - Owen's rule moved to the UI, where it still bites:
       `Session.reactionNotes()` returns the notes whose `targetSeq` is still a
       current surface node, in log order, frozen — so a compaction `replace`
       that shadows the reacted-to message takes the reaction with it, while the
       durable log keeps the record (a lapse is a projection decision, not a
       delete). It is a pure function of the log plus the surface, memoized per
       (log length, replacement generation), and it is NOT on the request path.
       The browser badge still comes from its own fold of the raw window
       (`SessionReactionNotes`, surfaced as `ConversationSnapshot.reactions`,
       painted by `ui-conversation`), which is why nothing in the client had to
       change.
     - **If the model must ever hear about a reaction**, the only cache-safe
       shape is a NEW event appended in a later turn — never a note spliced into
       history that was already sent. The identity test above is the proof
       obligation for any such change: at every turn boundary, appending the
       reaction-adjacent event must leave the previous prefix untouched.

     **Measured on this branch, not asserted** — the
     `apps/web/tests/fixture/react-note/` fixture was rewritten for the new rule
     and RE-RUN against the real built harness (isolated `DSH_HOME`, recording
     mock provider, the real `session.react` RPC):

     - `drive-react-note.mjs`: all 25 checks true, `failures: []`. The derived
       history is element-for-element identical before and after the note
       (`derivedTexts` equal, 4 messages either way); the reaction is in
       `reactionNotes()` on `targetSeq`; the NEXT turn's recorded request holds
       the note at NO index (its 6 messages are the first request's 4 plus the
       reply and the new prompt); a `/compact` whose span 7–55 spans the note at
       seq 23 puts no reaction text in the summarisation request, the durable
       checkpoint or the later request, and — the lifetime rule from the far
       side — the note lapsed from the UI projection because the compaction
       shadowed its target (seq 7) while the durable log still holds it.
     - `restart-check.mjs` on a FRESH session: all 8 checks true. After a real
       process restart on the same build and home, the conversation opens, both
       notes are in the log with their markers, both are shown by
       `reactionNotes()`, and the reopened model history contains no note at any
       index.
     - Both dumps are committed under that directory's `evidence/`.

     Also green in this tree: `pnpm run clean && pnpm install --frozen-lockfile
     && pnpm run build` (0), `node scripts/verify-deployment-build.ts` →
     `deployment build: current source and browser artifacts agree`,
     `npx vitest run` → `Test Files 845 passed | 9 skipped (854)`, `Tests 14101
     passed | 125 skipped (14226)`, `node --test .github/issue-management/policy.test.mjs`
     → 23/23, and `pnpm doc-sync`'s doc gates (type-equiv 392/392, pairing
     989/989, catalogs regenerate clean).

27. **Subagent sessions idle for six hours are destroyed** (`host/apiproxy`;
    ticket `b1458dbd`) — the household asked for dead subagent conversations to
    clear themselves rather than be cleared by hand. This is a fork-only
    lifecycle policy: upstream never deletes a session on its own, so an
    upstream pull drops it and the row has to be re-added (nothing else depends
    on it, and no upstream seam owns it).

    - **What it does.** `ApiProxyService` arms `src/subagent-idle-reaper.ts`: one
      pass at boot plus one per scan interval, destroying each **subagent**
      session whose last stored event is at least `idleMs` old — default six
      hours, hourly cadence.
    - **Where the threshold lives.** The gateway plugin config section
      `subagentIdleReap: { idleMs, scanIntervalMs }` (same normalized-defaults
      test and `docs/config-catalog.md` as the other rows). Validated at load:
      `idleMs` under one hour and `scanIntervalMs` under one minute are refused
      at boot. Idleness is read from the durable log's last event, never from
      process start, so a restart resets nobody's clock.
    - **What it deliberately does NOT touch.** Anything that is not a subagent
      session — `origin: 'subagent'` in the durable header is the only
      predicate, so a person's top-level conversation and a persistent
      `<profile>`-per-agent inbox row survive any age — and any session that is
      running or holds queued work, whatever its log age says. It also reaps
      nothing at all unless the gateway plugin passes the policy: a bare
      `createApiProxy` arms no timer.
    - **One destroy path.** The `session.destroy` handler body became the host
      function `destroySession` in `src/api-proxy.ts`; the RPC and the reaper
      both call it, so cancel-settle, descendant collection,
      workspace/projection cleanup and the commit-point ordering cannot drift.
      A refusal is logged with the session id and reason and retried next pass;
      the reaper never deletes a log to force an outcome.
    - **No turn behaviour, no UI.** No model call, title, inbox entry, budget or
      goal-round effect, and the browser needs no change at all — reaping is a
      Host concern.
    - **Proven, not asserted.** `packages/host/apiproxy/tests/subagent-idle-reaper.spec.ts`
      runs the real spine (JSONL persistence, real Agent lifecycles, a temporary
      home): the old subagent is gone from the log directory, the store and
      `session.list`, while a fresh subagent, a running one (asserted through the
      pass report's `running` reason, so the guard is proven ahead of the idle
      clock), one holding parked queued work, an old top-level conversation and
      an old `session-inbox-owen-delta` row all survive untouched; a refusal is
      logged, deletes nothing and retries; the exact threshold is idle and one
      millisecond newer is not; the config refuses nonsense at boot. Mutation
      checks: dropping the origin predicate, either live-work guard, or the
      inclusive threshold boundary each fails the suite.
28. **The React button and the badge the log folds back** (`client/runtime`,
    `client/ui-conversation`; ticket `f1a2c4ab`) — the client half of entry 26.
    Each durable message row carries copy and a React button; the button opens a
    fixed one-dozen unicode emoji table, and a choice appends one `session.react`
    note. There is no client-side reaction state and no optimistic paint: the
    badge is `ConversationSnapshot.reactions`, a fold of the raw
    `reaction/note` events the Session already holds, keyed by `targetSeq`, last
    note per target winning and a `removed` note dropping the entry. Three acts
    post three notes — `added`, `changed` when the chosen glyph differs from the
    recorded one, `removed` when it does not — each decided from the fold rather
    than from local state, so a reload reaches the same conclusion.

   - **Why the badge is not a Chat Node.** The note is log-only, so nothing
     assembles it and it paints no row; the fold reads the raw window for
     exactly that reason. If the badge were painted by a node the person would
     see "owen reacted 👍" as a message, so both halves are pinned rather than
     assumed: `reaction-note-transcript.client.spec.ts` (host-side, entry 26)
     and the rendered-transcript comparison in `chat-view.client.spec.tsx`,
     which asserts the flow's rows and words are unchanged and the only
     difference is the badge.
   - **`SessionReactionNotes`** (`packages/client/runtime/src/client/sessions/`)
     is the fold, modelled on `SessionQueueMirror`: `replace(events)` on open,
     resync and gap repair, `accept(event)` per durable append, and a snapshot
     contributing `reactions` to `ConversationSnapshot`. `ISession.react` is the
     one wire verb, `session.react` 1:1; the appended note's seq returns only so
     a caller can correlate it with the push frame, and the call's result is
     never awaited for rendering.
   - **The slot seam** is a second hook on the keyed Chat Node inject face:
     `ChatNodeInjected.hooks.reaction`, a `UseChatNodeReaction` that takes the
     row's target seq (or `undefined` for a row with no durable message) and
     returns the recorded reaction plus a fire-and-forget writer. `apply.ts`
     resolves the session binding and turns a business refusal into a rejection
     carrying the Host's own message, which the row renders as its refusal line;
     a row left with no target refuses to write at all.
   - **Keyboard and dismissal.** Escape, an outside press and choosing an entry
     all close the table and return focus to the React button. The table treats
     a press inside its anchor as the trigger's own: dismissing on the button's
     `pointerdown` and then toggling on the `click` behind it made the button
     open-only, which is the defect the recovered work carried and
     `reaction-actions.client.spec.tsx` now pins.
   - **Unproven here.** No browser run happened for this entry (see the ticket's
     validation note): the client half is proved against the merged Host
     contract in jsdom, not in a real browser against a real harness.
     `apps/web/tests/message-actions.e2e.ts` asserts an assistant footer row
     carries exactly one button and `.../snapshots/message-actions/ui.expected.md`
     records that row in the a11y tree; both move with this change and need
     `npm run test:web:refresh` in a browser-capable window.

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
