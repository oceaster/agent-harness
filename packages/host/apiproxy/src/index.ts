/**
 * @deepseek-ai/dsh-host-apiproxy — the API gateway every client shape shares:
 * the ApiProxy contract (api/: types + zod schemas, browser-safe), the fetch
 * carrier pair (fetch/: toFetchHandler on the host side, AbstractApiClient +
 * platform subclasses on the client side), and the host-side implementation
 * (api-proxy.ts: createApiProxy + the ApiProxyService gateway plugin providing
 * `ctx.apiProxy`). Transport-agnostic by design: this package registers no
 * routes — physical carriers wrap `ctx.apiProxy` themselves.
 *
 * The gateway consumes `ctx.agentDefaultModel`, the transport-independent default
 * shared with direct entry points. Switching models persists through that
 * service; sessions that have already logged a selection remain unchanged.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type { ApiProxy, EffortPolicyTable, SessionEffort } from './api/index.ts'
import {
  createApiProxy,
  DEFAULT_COLD_BLANK_PROBE_MAX_BYTES,
  DEFAULT_DESTROY_CANCEL_SETTLE_MS,
} from './api-proxy.ts'
import {
  DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
  type SessionLogCompressionLevel,
} from './session-export.ts'
import {
  DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS,
  DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS,
  SubagentIdleReapConfigSchema,
  type SubagentIdleReapConfig,
} from './subagent-idle-reaper.ts'

export type * from './api/index.ts'
export { RpcId } from './api/rpc.ts'
export { toFetchHandler } from './fetch/handler.ts'
export { AbstractApiClient, InProcessApiClient } from './fetch/client.ts'
export type { IApiClient } from './fetch/client.ts'
export { createApiProxy } from './api-proxy.ts'
export type { ApiProxyDefaults } from './api-proxy.ts'
export {
  DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS,
  DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS,
  MIN_SUBAGENT_IDLE_REAP_IDLE_MS,
  MIN_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS,
  SubagentIdleReapConfigSchema,
} from './subagent-idle-reaper.ts'
export type { SubagentIdleReapConfig } from './subagent-idle-reaper.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The host-side ApiProxy implementation (the transport-agnostic gateway face). */
    apiProxy: ApiProxy
  }
}

/** Gateway plugin configuration. */
export interface Config {
  /**
   * Whether this deployment can hand paths to a native desktop opener —
   * the `hasDocument` capability the agent-preset roster reports. Absent,
   * the platform is asked (macOS/Windows/WSL yes; Linux only with a display
   * server); set it explicitly where detection misleads, e.g. `false` in a
   * container whose DISPLAY points nowhere a user can see.
   */
  nativeOpen?: boolean
  /**
   * DEFLATE level for every session-log ZIP entry: `0` stores without
   * compression, `1` favors CPU/latency, and `9` favors archive size.
   * @default 6
   */
  sessionExportCompressionLevel?: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
  /**
   * Maximum physical size of a cold Session artifact eligible for blankness
   * verification. Zero disables probes.
   * @default 1024
   */
  coldBlankProbeMaxBytes?: number
  /**
   * How long `session.destroy` waits for a cancelled turn to settle before
   * reporting that nothing was deleted. Cancellation requests an abort rather
   * than forcing one, so this ceiling keeps a signal-ignoring adapter or tool
   * from turning Clear into a request that never returns.
   * @default 10000
   */
  destroyCancelSettleMs?: number
  /**
   * Fork-only housekeeping policy: automatically destroy subagent sessions that
   * have been idle past `idleMs`, one scan per `scanIntervalMs`. Idleness is
   * measured from the durable log's last event, never from process start, so a
   * restart resets nobody's clock. A session that is running, or whose Agent
   * holds queued work, is never reaped, and neither is anything that is not a
   * subagent (`origin: 'subagent'` in its durable header) — a person's own
   * conversation, including a persistent per-agent inbox row, is untouchable at
   * any age. Reaping reuses `session.destroy` in full; the reaper deletes no log
   * itself and a destroy refusal is logged and retried on the next pass.
   * `idleMs` must be at least one hour and `scanIntervalMs` at least one
   * minute: a nonsense value is refused when the plugin loads rather than
   * silently applied.
   * @default { idleMs: 21600000, scanIntervalMs: 3600000 }
   */
  subagentIdleReap?: SubagentIdleReapConfig
  /**
   * The deployment's effort policy per personality (or preset) id: what effort
   * each session actually runs at, the word its effort control paints, and
   * whether that control may open and may write. One table, one lookup, no
   * second source — a personality's level and its copy are the pair that must
   * never disagree, so they travel together from the same composition row.
   *
   * Each entry is checked when the plugin loads: `level` is required, `word`
   * must be a non-empty string when present, and `opens`/`editable`/`tree` must
   * be booleans. A malformed entry is refused outright rather than defaulted,
   * because a silently repaired policy paints the wrong word on a live control
   * — worse than a plugin that will not start. Absent, this deployment names no
   * policy and every session renders the ordinary editable control.
   * @default {}
   */
  effortPolicy?: EffortPolicyTable
}

/** The keys one policy entry may carry: the row field's own vocabulary, and nothing else. */
const EFFORT_POLICY_KEYS: readonly (keyof SessionEffort)[] = ['level', 'word', 'opens', 'editable', 'tree']

/**
 * Refuse an effort policy the row schema could not later carry.
 *
 * `schemastery` checks the declared TYPES but reads a `null` value as "present,
 * null", and the row's zod schema then rejects every row the gateway emits —
 * a load-time nuisance turned into a wire-time outage. A flag that is neither a
 * boolean nor absent is a mistake in the composition, so it is named here while
 * the plugin is still refusing to start.
 * @param table - the validated config table, possibly absent.
 * @throws Error naming the preset and key of the first malformed entry.
 */
export function assertEffortPolicy(table: EffortPolicyTable | undefined): void {
  for (const [preset, policy] of Object.entries(table ?? {})) {
    if (typeof policy.level !== 'string' || policy.level === '') {
      throw new Error(`effortPolicy[${JSON.stringify(preset)}].level must be a non-empty string`)
    }
    for (const key of Object.keys(policy)) {
      if (!(EFFORT_POLICY_KEYS as readonly string[]).includes(key)) {
        // The row schema strips a key it does not name, so an unknown one would
        // vanish in transit and the control would quietly ignore what the
        // composition said. Name it while the plugin is still refusing to start.
        throw new Error(`effortPolicy[${JSON.stringify(preset)}].${key} is not a policy key; `
          + `expected one of ${EFFORT_POLICY_KEYS.join(', ')}`)
      }
    }
    for (const key of ['word', 'opens', 'editable', 'tree'] as const) {
      const value = policy[key]
      if (value === undefined) continue
      if (typeof value !== (key === 'word' ? 'string' : 'boolean') || (key === 'word' && value === '')) {
        throw new Error(`effortPolicy[${JSON.stringify(preset)}].${key} must be a `
          + `${key === 'word' ? 'non-empty string' : 'boolean'} when present, got ${JSON.stringify(value)}`)
      }
    }
  }
}

/**
 * The API gateway service: implements the ApiProxy contract over the composed
 * host context and provides it as `ctx.apiProxy`. The Host cwd is the default
 * project directory.
 */
export class ApiProxyService extends Service implements ApiProxy {
  static inject = [
    'agentDefaultModel', 'agents', 'attachments', 'directoryPicker', 'llm', 'sessions', 'subagents', 'sessionQuery',
    'tools', 'userQuestions', 'workspaceRegistry',
  ]

  static Config: z<Config> = z.object({
    nativeOpen: z.boolean(),
    sessionExportCompressionLevel: z.number().step(1).min(0).max(9)
      .default(DEFAULT_SESSION_LOG_COMPRESSION_LEVEL) as z<SessionLogCompressionLevel>,
    coldBlankProbeMaxBytes: z.natural().default(DEFAULT_COLD_BLANK_PROBE_MAX_BYTES),
    destroyCancelSettleMs: z.natural().default(DEFAULT_DESTROY_CANCEL_SETTLE_MS),
    subagentIdleReap: SubagentIdleReapConfigSchema,
    // `z.dict` of a strict object: an unknown policy key is dropped by the
    // object shape, but every named key is type-checked, so a string where a
    // flag belongs, an empty word, or a policy with no level refuses the load.
    effortPolicy: z.dict(z.object({
      level: z.string().min(1).required(),
      word: z.string().min(1),
      opens: z.boolean(),
      editable: z.boolean(),
      tree: z.boolean(),
    })),
  })

  readonly sessions: ApiProxy['sessions']
  readonly subagents: ApiProxy['subagents']
  readonly workspace: ApiProxy['workspace']
  readonly host: ApiProxy['host']
  readonly goals: ApiProxy['goals']
  readonly skills: ApiProxy['skills']
  readonly agentPresets: ApiProxy['agentPresets']
  readonly settings: ApiProxy['settings']
  readonly credentials: ApiProxy['credentials']
  readonly llm: ApiProxy['llm']
  readonly events: ApiProxy['events']
  readonly downloads: ApiProxy['downloads']
  readonly respond: ApiProxy['respond']

  constructor(ctx: Context, config: Config) {
    super(ctx, 'apiProxy')
    assertEffortPolicy(config.effortPolicy)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ctx.agentDefaultModel.currentSelection(),
      saveDefaultModelSelection: selection => ctx.agentDefaultModel.saveSelection(selection),
      cwd: process.cwd(),
      ...config.nativeOpen === undefined ? {} : { canOpenPath: () => config.nativeOpen as boolean },
      ...(config.sessionExportCompressionLevel === undefined
        ? {}
        : { sessionExportCompressionLevel: config.sessionExportCompressionLevel }),
      ...(config.coldBlankProbeMaxBytes === undefined
        ? {}
        : { coldBlankProbeMaxBytes: config.coldBlankProbeMaxBytes }),
      ...(config.destroyCancelSettleMs === undefined
        ? {}
        : { destroyCancelSettleMs: config.destroyCancelSettleMs }),
      // Always passed: this plugin owns the housekeeping policy, so its shipped
      // default (six hours idle, hourly scan) is what a deployment runs.
      subagentIdleReap: config.subagentIdleReap ?? {
        idleMs: DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS,
        scanIntervalMs: DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS,
      },
      // Always passed, even as `{}`: the gateway owns the effort face, and an
      // empty table is the honest statement that this deployment names none
      // (an absent one would read the same, but passing it keeps one branch).
      effortPolicy: config.effortPolicy ?? {},
    })
    this.sessions = api.sessions
    this.subagents = api.subagents
    this.workspace = api.workspace
    this.host = api.host
    this.goals = api.goals
    this.skills = api.skills
    this.agentPresets = api.agentPresets
    this.settings = api.settings
    this.credentials = api.credentials
    this.llm = api.llm
    this.events = api.events
    this.downloads = api.downloads
    // createApiProxy returns closures (no `this` capture), so the bind is
    // behavior-neutral.
    this.respond = api.respond.bind(api)
  }
}

export default ApiProxyService
