/**
 * Model selection plugin, browser half — TWO entries over ONE per-session
 * directory owned by ModelDirectoryResolver (`ctx.modelDirectories`). The /model popupSelect
 * contribution and the composer's named `conversation.input.model` seat both
 * load the session's provider-grouped advisory directory (`session.models`)
 * and submit through `session.selectModel` via the same directory instance,
 * so the host-reported current selection is the single fact both surfaces echo
 * — a switch made in either entry is what the other shows next. Failures
 * ride each entry's own retry surface (popup shell error/retry; seat menu
 * inline error) without forking the state. Addressed subagent sessions expose
 * neither entry because those Agent-bound RPCs would activate persisted
 * history outside the direct-parent continuation path.
 *
 * The composer seat additionally renders ONE effort policy per session
 * (`EffortPolicy`), published by the deployment on the session-list row: an
 * agent whose effort is off can paint `Off` and refuse to open a dialog, a
 * read-only conversation can open a locked dialog at its own delegated level,
 * and a coordinator's bar can sit at the highest effort in its own session
 * tree while its text stays fixed. Absent that field the seat is the ordinary
 * editable control this package has always shipped.
 */
// Type-only: the carrier types, the forwarded Host-event face and the ctx.remote merge.
import type { ModelSelection, SessionModels } from '@deepseek-ai/dsh-api-remotes/client'
import type {
  ClientContext, ISessions, ObservableSnapshot, SessionId, SessionListState, SessionSummary,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { CommandUiContract, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
// Type-only: pulls the ui-conversation SlotMap merge (the input.model seat).
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from './directory.ts'
import { ModelDirectoryResolver } from './service.ts'
import { ORDINARY_EFFORT_POLICY, type EffortPolicy, type ModelSelectInjected } from './slots.ts'
import { ModelSelect } from './ModelSelect.tsx'
import { en, zh, type ModelKey } from './locales.ts'

export { ModelDirectory } from './directory.ts'
export type { ModelDirectoryState } from './directory.ts'
export { ModelDirectoryResolver } from './service.ts'
export { ORDINARY_EFFORT_POLICY } from './slots.ts'
export type { EffortPolicy, ModelSelectInjected } from './slots.ts'
export type { ModelKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The model selection surfaces' copy (/model popup + composer seat). */
    model: ModelKey
  }
}

/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
function rowId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

/** Flatten the directory into popup rows; failure rows are listed for visibility but never selectable. */
function optionsOf(directory: SessionModels, t: TranslateNS<'model'>): SelectOption[] {
  const rows: SelectOption[] = []
  for (const group of directory.groups) {
    for (const model of group.models) {
      rows.push({
        id: rowId(group.id, model.id),
        label: model.name,
        detail: model.description !== undefined ? `${group.name} · ${model.description}` : group.name,
        ...(directory.current.provider === group.id && directory.current.model === model.id
          ? { active: true } : {}),
      })
    }
  }
  for (const failure of directory.failures) {
    rows.push({
      id: `failure/${failure.id}`,
      label: failure.name,
      detail: t('option.loadError', { message: failure.message }),
    })
  }
  return rows
}

/**
 * Resolve a picked row back to its model selection by matching against the loaded
 * groups (the same data the rows were built from — ids stay opaque).
 * @param state - the session's directory snapshot.
 * @param id - the picked row id.
 * @returns the row's model selection, or undefined for failure rows / stale ids.
 */
function selectionOf(state: ModelDirectoryState, id: string): ModelSelection | undefined {
  for (const group of state.groups) {
    for (const model of group.models) {
      if (rowId(group.id, model.id) !== id) continue
      const sameRoute = state.current?.provider === group.id && state.current.model === model.id
      const reasoningEffort = sameRoute
        ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
        : model.reasoning?.defaultEffort
      return {
        provider: group.id,
        model: model.id,
        ...reasoningEffort === undefined ? {} : { reasoningEffort },
      }
    }
  }
  return undefined
}

/** Dictionary namespace owned by this plugin. */
const NS = 'model'

/**
 * The per-session effort state a deployment publishes on a session-list row,
 * beside `agentPreset`. Measured 2026-10-24: the client store's `SessionSummary`
 * carries NO model selection (`session.models` is refused with `agent-busy` for
 * the addressed subagent sessions a tree walk needs), so the deployment supplies
 * it here instead — one field, read defensively: absent means this deployment
 * names no policy and the control stays the ordinary editable one.
 *
 * The household deployment fills it from infra/dsh/personalities.json, which is
 * already the one configured source of `reasoningEffort` per personality:
 * Delta `low` → `{ level: 'low', word: 'Dynamic', opens: true, editable: false,
 * tree: true }`, Darwin `max` → `{ level: 'max', word: 'Max', opens: false,
 * editable: false }`, Diana `off` → `{ level: 'off', word: 'Off', opens: false,
 * editable: false }`. `word` travels verbatim rather than being derived from the
 * adapter's level name, because Owen's copy is the requirement.
 */
export interface SessionEffortField {
  /** The effort id this conversation actually runs at — the tree bar's only input, so every row
   *  that can be someone's descendant carries it. */
  level?: string
  /** The word the control paints in place of a level name: `Off`, `Max`, `Dynamic`. */
  word?: string
  /** Whether the trigger opens the dialog; absent = true. */
  opens?: boolean
  /** Whether the dialog may write; absent = true. */
  editable?: boolean
  /** Whether the bar sits at the highest `level` anywhere in this session's own subtree; absent = false. */
  tree?: boolean
  /** PARKED with the read-only worker case: a level track for a conversation whose own directory can never load. */
  track?: { names: readonly string[]; index: number }
}

/**
 * Read one row's deployment-published effort field.
 * @param row - the session-list row, or undefined when the session is not listed yet.
 * @returns the field, or undefined when this deployment names no policy.
 */
function effortFieldOf(row: SessionSummary | undefined): SessionEffortField | undefined {
  const field = (row as (SessionSummary & { effort?: SessionEffortField }) | undefined)?.effort
  return typeof field === 'object' && field !== null ? field : undefined
}

/**
 * Every effort level used BELOW one session, walked the way
 * `indexSubagentDescendants` counts them: only an uninterrupted
 * `origin: 'subagent'` chain connects, so an ordinary fork terminates
 * propagation, orphans fall out, and a cycle fails soft.
 * @param rows - the retained session summaries keyed by id.
 * @param root - the session whose subtree is collected.
 * @returns the descendant effort ids, empty when nothing below the session reports one.
 */
function descendantEffortsOf(rows: Readonly<Record<SessionId, SessionSummary>>, root: SessionId): string[] {
  const efforts: string[] = []
  const seen = new Set<SessionId>([root])
  let frontier: SessionId[] = [root]
  while (frontier.length > 0) {
    const parents = new Set(frontier)
    frontier = []
    for (const row of Object.values(rows)) {
      if (row.origin !== 'subagent' || row.parentId === undefined) continue
      if (!parents.has(row.parentId) || seen.has(row.id)) continue
      seen.add(row.id)
      frontier.push(row.id)
      const level = effortFieldOf(row)?.level
      if (level !== undefined) efforts.push(level)
    }
  }
  return efforts
}

/**
 * One session's rendered policy: the deployment's field, plus the tree walk the
 * tree-max bar needs. Delta's bar sits at the highest effort in its own tree
 * while its value text still reads that field's word. The walk runs only for a
 * row that asked for it (`tree: true`): a named session with a fixed word and no
 * tree bar must never grow one.
 * @param rows - the session-list snapshot.
 * @param sessionId - the session whose control renders.
 * @returns the policy; `ORDINARY_EFFORT_POLICY` when nothing is named for it.
 */
function policyOf(rows: SessionListState, sessionId: SessionId): EffortPolicy {
  const field = effortFieldOf(rows.byId[sessionId])
  if (field === undefined) return ORDINARY_EFFORT_POLICY
  const treeEfforts = field.tree === true ? descendantEffortsOf(rows.byId, sessionId) : []
  return {
    opens: field.opens ?? true,
    editable: field.editable ?? true,
    ...(field.word === undefined ? {} : { word: field.word }),
    ...(treeEfforts.length === 0 ? {} : { treeEfforts }),
    ...(field.track === undefined ? {} : { track: field.track }),
  }
}

/** Value key for policy identity: a republish that changed nothing must not re-render the seat. */
function policyKey(policy: EffortPolicy): string {
  return JSON.stringify([policy.opens, policy.editable, policy.word ?? null, policy.treeEfforts ?? null,
    policy.track === undefined ? null : [policy.track.names, policy.track.index]])
}

/**
 * Bind one session's policy over the session list, so a worker's level moving
 * moves Delta's bar without any second data path.
 * @param sessions - the client sessions service holding the retained list.
 * @param sessionId - the session whose control renders.
 * @returns an observable policy source, identity-stable between real changes.
 */
function createPolicySource(sessions: ISessions, sessionId: SessionId): ObservableSnapshot<EffortPolicy> {
  let cached = ORDINARY_EFFORT_POLICY
  let cachedKey = policyKey(cached)
  return {
    getSnapshot: () => {
      const next = policyOf(sessions.list.getSnapshot(), sessionId)
      const key = policyKey(next)
      if (key !== cachedKey) { cached = next; cachedKey = key }
      return cached
    },
    subscribe: listener => sessions.list.subscribe(listener),
  }
}

/** Required services: the contribution registry, the seat's slot registry, locale, and the service's own faces. */
export const inject = ['commandUi', 'connection', 'locale', 'sessions', 'slots', 'remote']

/**
 * Client plugin body: mount ModelDirectoryResolver, register the `model` dictionaries,
 * then register the /model popup contribution and the composer model seat
 * over the service.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-selection: dictionaries')

  // Non-slot faces (the command description, the popup option builder) read
  // through the bound translate; the seat component reads the standard seat.
  const t = ctx.locale.bind(NS)

  // The composer-block reason is this plugin's own copy, read at raise time so
  // a locale change reaches the next publish.
  ctx.plugin(ModelDirectoryResolver, { blockReason: () => t('blocked.composer') })

  // Entry 1: the /model popupSelect over the shared directory. The command
  // description is registry-held text: it reads t() once at registration and
  // refreshes only on re-registration, not on locale change.
  ctx.inject(['commandUi', 'modelDirectories'], (scope: ClientContext) => {
    const command = scope.get('commandUi') as CommandUiContract
    const models = scope.modelDirectories
    const sessions = scope.sessions
    scope.effect(() => command.register({
      name: 'model',
      description: t('command.description'),
      available: () => false,
      ui: {
        kind: 'popupSelect',
        options: async (session) => {
          if (sessions.subagentAddress(session.sessionId) !== undefined) {
            throw new Error('model selection is unavailable for addressed subagent sessions')
          }
          return optionsOf(await models.directoryFor(session.sessionId).load(), t)
        },
        onSelect: async (option, session) => {
          if (sessions.subagentAddress(session.sessionId) !== undefined) {
            throw new Error('model selection is unavailable for addressed subagent sessions')
          }
          const directory = models.directoryFor(session.sessionId)
          const selection = selectionOf(directory.store.getSnapshot(), option.id)
          if (selection === undefined) {
            throw new Error('this provider\'s catalog failed to load — pick a model from a loaded group')
          }
          await directory.select(selection)
        },
      },
    }), 'ui-model-selection: /model contribution')
  })

  // Entry 2: the composer's named model seat over the SAME directory.
  ctx.inject(['slots', 'modelDirectories'], (scope: ClientContext) => {
    const models = scope.modelDirectories
    const sessions = scope.sessions
    // One policy source per session, for the plugin's lifetime: the source is
    // a closure over the retained list, and a household has far fewer sessions
    // than it takes to matter.
    const policies = new Map<SessionId, ObservableSnapshot<EffortPolicy>>()
    const policySourceFor = (sessionId: SessionId): ObservableSnapshot<EffortPolicy> => {
      const existing = policies.get(sessionId)
      if (existing !== undefined) return existing
      const created = createPolicySource(sessions, sessionId)
      policies.set(sessionId, created)
      return created
    }
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      locale: NS,
      inject: (sessionId): ModelSelectInjected => {
        const directory = models.directoryFor(sessionId)
        // An addressed subagent session renders nothing: those Agent-bound RPCs
        // would activate persisted history outside the direct-parent
        // continuation path. PARKED (Owen deferred the worker case on
        // 2026-10-24): `EffortPolicy.track` already knows how to paint such a
        // session read-only, but it stays unreachable until a worker surface
        // mounts this seat at all — see the note on `track` in slots.ts.
        const inspectable = sessions.subagentAddress(sessionId) === undefined
        return {
          available: inspectable,
          policy: policySourceFor(sessionId),
          directory: directory.store,
          load: () => {
            if (inspectable) directory.load().catch(() => { /* surfaced on the store */ })
          },
          select: (selection: ModelSelection) => inspectable
            ? directory.select(selection).then(() => true, () => false)
            : Promise.resolve(false),
        }
      },
    }, ModelSelect))
  })
}
