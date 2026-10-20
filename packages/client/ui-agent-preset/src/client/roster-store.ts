/**
 * Agent-preset roster reader.
 *
 * The header label names the preset a session runs, so it needs the roster's
 * display copy rather than any setting: one `agentPreset.list` call answers
 * what every preset is called and what it is for. Nothing here writes — this
 * deployment chooses an agent per inbox row, and the preset default belongs to
 * the composition.
 */

import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/**
 * Human text for a rejected wire call. A transport failure rejects with an
 * Error; a host or a runtime can reject with anything, and the caller still
 * has to decide what to show.
 * @param error - the rejection value.
 * @returns the message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One selectable preset. */
export interface AgentPresetOption {
  /** Preset id, also the label's fallback text. */
  id: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for. */
  description?: string
}

/** One roster entry exactly as the host reports it. */
interface RosterPreset {
  /** Preset id and directory name. */
  id: string
  /** Whether the preset ships with the deployment or was authored locally. */
  trust: 'system' | 'user'
  /** Whether a session that names no preset gets this one. */
  isDefault: boolean
  /** Display name the preset published, absent when it published none. */
  name?: string
  /** One sentence on what the preset is for, absent when it published none. */
  description?: string
  /** Why the preset cannot compose a session, absent when it can. */
  broken?: string
}

/** The roster the host answered with. */
interface RosterValue {
  /** Every preset the deployment composes, in the order the host lists them. */
  presets: readonly RosterPreset[]
  /** Whether this browser may author presets at all. */
  authorable: boolean
  /** Whether the host can open a preset directory on a native desktop. */
  hasDocument: boolean
}

/** The roster, or the message to show in its place. */
type RosterRead = { ok: true; value: RosterValue } | { ok: false; error: string }

/**
 * Read the roster, folding both refusal shapes into one message.
 *
 * The wire refuses in two ways — the transport rejects, or it answers an
 * `ok: false` envelope — and the caller treats them identically.
 * @param api - the agent-preset wire face.
 * @returns the roster, or the message to show in its place.
 */
async function readRoster(api: Pick<IApiClient, 'agentPresets'>): Promise<RosterRead> {
  try {
    const response = await api.agentPresets.list({})
    return response.result.ok
      ? { ok: true, value: response.result.value }
      : { ok: false, error: response.result.error.message }
  } catch (error) {
    return { ok: false, error: messageOf(error) }
  }
}

/**
 * The roster entries as a reader renders them: healthy presets only.
 *
 * A broken preset cannot compose a session, and the label only ever looks up
 * a preset a session already runs, so an entry that failed to load carries no
 * usable display copy. `exactOptionalPropertyTypes` makes "absent" and
 * "present as undefined" different shapes, so the spread dance lives here.
 * @param presets - the roster the host answered with.
 * @returns one option per readable preset, in roster order.
 */
function presetOptions(
  presets: readonly { id: string; trust: 'system' | 'user'; name?: string; description?: string; broken?: string }[],
): AgentPresetOption[] {
  return presets.filter(preset => preset.broken === undefined).map(preset => ({
    id: preset.id,
    trust: preset.trust,
    ...preset.name === undefined ? {} : { name: preset.name },
    ...preset.description === undefined ? {} : { description: preset.description },
  }))
}

/** Roster snapshot the label reads. */
export interface AgentPresetRosterState {
  /** `unavailable` means the deployment composes no presets, or the read failed. */
  status: 'idle' | 'loading' | 'ready' | 'unavailable'
  /** Display copy per preset; empty until a read lands. */
  options: readonly AgentPresetOption[]
}

const INITIAL: AgentPresetRosterState = { status: 'idle', options: [] }

/**
 * Read the roster once per load request. A failed read leaves an empty roster,
 * so the label falls back to the session's recorded preset id rather than
 * naming a preset from stale copy.
 */
export class AgentPresetRosterController {
  /** Roster snapshot the renderer subscribes to. */
  readonly store: SnapshotStore<AgentPresetRosterState> = createSnapshotStore(INITIAL)

  /**
   * @param api - the agent-preset wire face.
   */
  constructor(private readonly api: Pick<IApiClient, 'agentPresets'>) {}

  /**
   * Read the roster. Concurrent loads collapse into the one in flight: the
   * answer is the same either way, and a session switch re-asks constantly.
   * @returns once the snapshot reflects the host.
   */
  async load(): Promise<void> {
    const before = this.store.getSnapshot()
    if (before.status === 'loading') return
    this.store.set({ ...before, status: 'loading' })
    const roster = await readRoster(this.api)
    const options = roster.ok ? presetOptions(roster.value.presets) : []
    this.store.set({ status: options.length === 0 ? 'unavailable' : 'ready', options })
  }
}
