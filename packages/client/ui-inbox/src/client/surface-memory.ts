/**
 * WHERE YOU WERE, one record per (person, surface) — the memory that makes the
 * two interfaces two workspaces instead of one interface with two lists.
 *
 * Owen, 2026-10-24: "when switching between Delta/Epsilon views always default
 * the last known read/write inbox session or agent channel for the Delta view.
 * And default to the last known Epsilon read only session for the Epsilon view."
 * So the memory is NOT one shared "where you were": the Delta surface keeps the
 * last write-able thing you were reading there (an agent conversation or an
 * agent channel), and the Epsilon surface keeps the last read-only unit you had
 * open. Moving between them is moving, not starting over.
 *
 * THE RECORD is {@link SurfacePlace}: `{ kind, id, at }`. `kind` is the TYPE of
 * the target and therefore also which surface may use it ({@link PLACE_KINDS}) —
 * a channel on the Epsilon surface or a worker on the Delta surface is a
 * mismatched kind, and a mismatched kind is the same as no record at all.
 *
 * WHERE IT LIVES: one `SnapshotStore` with the opt-in persistence the channel
 * selection already used (`createSnapshotStore(..., { persist })` →
 * `localStorage`), keyed `dsh.inbox.places`, holding a map
 * `person id -> surface -> place`. Per PERSON, not per browser: the same browser
 * is genuinely shared in this household (sign-in swaps the person on one
 * machine), so one member's place is never restored for another. Keying the
 * record by person is what makes that true even before the server's own
 * per-person data has a chance to disagree.
 *
 * WHY ONE STORE AND NOT TWO. The channel selection used to persist its own id
 * (`dsh.inbox.channel`) because it was the only memory the app had. Two durable
 * copies of the same fact — the channel a person is reading, written by two
 * writers in two ticks — is exactly how "where you were" ends up disagreeing
 * with what is painted. So this store is now the ONLY durable record, the
 * channel controller's selection became memory-only, and
 * {@link SurfaceMemory.adoptLegacyChannel} reads the old key once so nobody
 * loses their channel across the change.
 *
 * WHAT THIS MODULE OWNS, and the split that keeps it honest: the record and the
 * DECISION ({@link planRestore}, pure). It does not know about React, cordis,
 * the sessions service or the layout — index.ts is where a plan becomes a
 * paint, because painting happens in the same write that makes the surface
 * visible.
 */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { HarnessSurface } from './surface.ts'

/** What one surface can remember: a conversation, a channel, or a read-only unit. */
export type SurfacePlaceKind = 'agent' | 'channel' | 'worker'

/** One remembered place. `id` is the surface's own address, never a display name. */
export interface SurfacePlace {
  /** The kind of target, which is also which surface may restore it. */
  readonly kind: SurfacePlaceKind
  /**
   * The target's address: the agent id (kind `agent`), the channel id (kind
   * `channel`), or the child session id the epsilon list opens (kind `worker` —
   * the same address `openWorker`/`sessions.openSubagent` already take).
   */
  readonly id: string
  /** Epoch milliseconds of the selection this record describes. */
  readonly at: number
}

/**
 * Which kinds belong to which surface.
 *
 * This is the whole of the "do not restore a channel id on the Epsilon surface
 * or a worker address on the Delta surface" rule: the kind is the type of the
 * record, and a kind that is not in this table for that surface reads as no
 * record.
 */
export const PLACE_KINDS: Readonly<Record<HarnessSurface, readonly SurfacePlaceKind[]>> = {
  inbox: ['agent', 'channel'],
  epsilons: ['worker'],
}

/** The persisted shape: person id → the place they left on each surface. */
export type SurfacePlaces = Readonly<Record<string, Partial<Record<HarnessSurface, SurfacePlace>>>>

/** The localStorage key this store owns (`createSnapshotStore` prefixes nothing). */
export const PLACES_KEY = 'dsh.inbox.places'

/**
 * The key the channel selection used to own, read once so the person who was
 * reading a channel when this build lands keeps it. See
 * {@link SurfaceMemory.adoptLegacyChannel}.
 */
export const LEGACY_CHANNEL_KEY = 'dsh.inbox.channel'

/** Every surface, for the record's two halves. */
const SURFACES: readonly HarnessSurface[] = ['inbox', 'epsilons']

/**
 * Whether a value off storage is a place this surface may restore.
 *
 * Storage is not trusted: it survives builds, it can be hand-edited, and a
 * half-written entry must read as "no record" rather than throw inside a store
 * subscription. The kind table is applied here too, so a place that belongs to
 * the other surface can never reach a restore.
 * @param surface - the surface the record is being read for.
 * @param value - the value found under that surface's key.
 * @returns the validated place, or null when it is not one this surface may use.
 */
export function placeFor(surface: HarnessSurface, value: unknown): SurfacePlace | null {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as { kind?: unknown; id?: unknown; at?: unknown }
  if (typeof candidate.kind !== 'string' || typeof candidate.id !== 'string') return null
  if (candidate.id === '') return null
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) return null
  const kind = candidate.kind as SurfacePlaceKind
  if (!PLACE_KINDS[surface].includes(kind)) return null
  return { kind, id: candidate.id, at: candidate.at }
}

/**
 * The record for one (person, surface), validated.
 * @param places - the whole persisted book.
 * @param person - the signed-in person's id, or null before the roster lands.
 * @param surface - the surface to read.
 * @returns the place, or null when there is none this surface may restore.
 */
export function placeIn(
  places: SurfacePlaces,
  person: string | null,
  surface: HarnessSurface,
): SurfacePlace | null {
  if (person === null) return null
  const byPerson = places[person]
  if (typeof byPerson !== 'object' || byPerson === null) return null
  return placeFor(surface, byPerson[surface])
}

/** The per-(person, surface) memory, persisted with the app's own store engine. */
export class SurfaceMemory {
  /**
   * The durable book. `persist` is the same mechanism the channel selection used
   * (`createSnapshotStore`'s `persist` option), so a reload finds it again with
   * no second storage path in this plugin.
   */
  readonly store: SnapshotStore<SurfacePlaces> = createSnapshotStore<SurfacePlaces>(
    {}, { persist: { name: PLACES_KEY } })

  /** False once the legacy channel key has been dealt with (see adoptLegacyChannel). */
  private legacyPending = true

  /**
   * The place one person left on one surface.
   * @param person - the signed-in person's id, or null before the roster lands.
   * @param surface - the surface to read.
   * @returns the validated place, or null when there is none.
   */
  placeOf(person: string | null, surface: HarnessSurface): SurfacePlace | null {
    return placeIn(this.store.getSnapshot(), person, surface)
  }

  /**
   * Record where a person is, inside one surface.
   *
   * Called when the SELECTION CHANGES in that surface — a row click, a channel
   * row, a worker row, or an address the parent posted — never on a render and
   * never on a poll, because a record that is rewritten by frames cannot tell
   * "where you were" apart from "where the app happens to point".
   *
   * A person this app has not resolved yet is not written for: there is nobody
   * to attribute the place to, and the roster is always read before any row can
   * be clicked.
   * @param person - the signed-in person's id, or null before the roster lands.
   * @param surface - the surface the selection changed in.
   * @param kind - the kind of target the person moved to.
   * @param id - that target's address.
   * @param at - epoch milliseconds of the move (tests pin it; production omits).
   * @returns whether the record changed, so a caller may assert idempotence.
   */
  remember(
    person: string | null,
    surface: HarnessSurface,
    kind: SurfacePlaceKind,
    id: string,
    at: number = Date.now(),
  ): boolean {
    if (person === null) return false
    // A kind the surface cannot restore is not a record: it would be dropped on
    // the way back in, so writing it would only teach the store a lie.
    if (!PLACE_KINDS[surface].includes(kind)) return false
    const current = this.placeOf(person, surface)
    if (current !== null && current.kind === kind && current.id === id) return false
    const places = this.store.getSnapshot()
    this.store.set({ ...places, [person]: { ...places[person], [surface]: { kind, id, at } } })
    return true
  }

  /**
   * Forget one surface's place for one person. Used when a record is dropped
   * because its target no longer resolves, so the dead address cannot sit in
   * storage to be re-dropped on every reload.
   * @param person - the signed-in person's id, or null.
   * @param surface - the surface whose record is being retired.
   * @returns whether anything was removed.
   */
  forget(person: string | null, surface: HarnessSurface): boolean {
    if (person === null) return false
    const places = this.store.getSnapshot()
    const byPerson = places[person]
    if (byPerson === undefined || byPerson[surface] === undefined) return false
    const { [surface]: _dropped, ...rest } = byPerson
    this.store.set({ ...places, [person]: rest })
    return true
  }

  /**
   * Adopt the channel the previous build remembered, once.
   *
   * The channel selection persisted its own id under `dsh.inbox.channel`; that
   * key is retired in favour of this store (one durable record, one writer), so
   * the person who was reading a channel when this build arrives would otherwise
   * be sent back to their conversation. Exactly once, exactly one person:
   *
   *   - the id is adopted only for the person signed in NOW, and only when this
   *     store has no Delta record for them — a real record always wins over a
   *     leftover key;
   *   - it is adopted only if the server's own channel list still offers it, so
   *     a dead id cannot be resurrected by storage;
   *   - the key is removed either way, so the next person on this browser
   *     inherits nothing.
   *
   * Waits (and keeps the key) while the channel list has not arrived: an unknown
   * list is not an absent channel.
   * @param person - the signed-in person's id, or null before the roster lands.
   * @param channelIds - the channel ids the server returned for this person.
   * @returns whether a channel was adopted.
   */
  adoptLegacyChannel(person: string | null, channelIds: readonly string[]): boolean {
    if (!this.legacyPending || person === null || channelIds.length === 0) return false
    const stored = readLegacyChannel()
    if (stored === null) {
      this.legacyPending = false
      return false
    }
    // The key is dealt with from here on, whatever the answer: it is retired
    // below or dropped below, and neither is worth retrying.
    this.legacyPending = false
    const adopted = this.placeOf(person, 'inbox') === null && channelIds.includes(stored)
    if (adopted) this.remember(person, 'inbox', 'channel', stored)
    removeLegacyChannel()
    return adopted
  }
}

/**
 * The channel id the previous build persisted, if it is still there and sane.
 * @returns the id, or null when the key is absent or holds something else.
 */
function readLegacyChannel(): string | null {
  if (typeof localStorage === 'undefined') return null
  try {
    const raw = localStorage.getItem(LEGACY_CHANNEL_KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return null
    const channelId = (parsed as { channelId?: unknown }).channelId
    return typeof channelId === 'string' && channelId !== '' ? channelId : null
  } catch {
    return null
  }
}

/** Remove the retired key. A storage failure here only leaves a stale entry. */
function removeLegacyChannel(): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.removeItem(LEGACY_CHANNEL_KEY)
  } catch { /* Private mode: the entry simply stays, and is dropped again next load. */ }
}

// ─── the decision ───────────────────────────────────────────────────────────

/**
 * What a surface should do with its memory when it becomes visible.
 *
 * - `addressed`: an explicit address is in force, so the record does not speak
 *   this time. The address wins and becomes the record by the ordinary open
 *   path; nothing else is painted.
 * - `none`: nothing to do, because this surface's own place is already on
 *   screen (or nothing at all is). No store is written; the shell is left alone.
 * - `adopt`: this surface has no record yet, and the pane is already painting one
 *   of ITS OWN targets — the runtime's persisted selection, which is where a
 *   person who has not clicked since this build landed still is. The caller
 *   writes that as the record (where they are becomes what is remembered) and
 *   paints nothing.
 * - `wait`: the record exists but the data that proves it is not here yet. The
 *   caller keeps the surface armed and tries again on the next write.
 * - `default`: the record's target is GONE, or the pane is painting the OTHER
 *   surface's selection. Either way this surface paints its own default and
 *   forgets the dead record; nothing failed, so nothing is said.
 * - `agent`/`channel`/`worker`: the resolved target to paint.
 */
export type RestorePlan =
  | { readonly action: 'addressed' }
  | { readonly action: 'none' }
  | { readonly action: 'adopt'; readonly kind: 'agent' | 'worker'; readonly id: string }
  | { readonly action: 'wait' }
  | { readonly action: 'default' }
  | { readonly action: 'agent'; readonly sessionId: string }
  | { readonly action: 'channel'; readonly id: string }
  | { readonly action: 'worker'; readonly id: string }

/** One agent row, as the inbox API returned it (structural: see inbox-api.ts). */
export interface PlaceAgentRow {
  readonly agent: string
  readonly sessionId: string | null
  readonly enabled?: boolean
}

/** One unit row, as Delta's own catalog listed it (structural: see inbox-controller.ts). */
export interface PlaceWorkerRow {
  readonly id: string
  readonly mode?: 'one-shot' | 'continuable'
  readonly damaged: boolean
}

/** Everything the decision reads, gathered by the caller from the live stores. */
export interface RestoreInputs {
  /** The surface that just became visible. */
  readonly surface: HarnessSurface
  /** The person's record for it, already validated. */
  readonly place: SurfacePlace | null
  /**
   * The conversation an explicit address asked for, or null. Only the Delta
   * surface can carry one: the URL and the wire both name an agent, and a
   * worker has no address of its own.
   */
  readonly addressed: string | null
  /** Whether that surface's own data has been read (rows, or Delta's roster). */
  readonly ready: boolean
  /** The person's agent rows. */
  readonly rows: readonly PlaceAgentRow[]
  /** The channel ids the server returned for this person. */
  readonly channelIds: readonly string[]
  /** Delta's roster, which is where a unit address is resolved. */
  readonly workers: readonly PlaceWorkerRow[]
  /** Session ids the client's session list carries (what `sessions.open` accepts). */
  readonly listed: readonly string[]
  /** The conversation the pane is painting right now, if any. */
  readonly current: string | undefined
}

/**
 * Decide what a surface does with its memory. Pure, so the whole ordering rule
 * can be read — and tested — in one place:
 *
 *   1. AN EXPLICIT ADDRESS BEATS THE RECORD. A cold load of `#c/<agent>` or a
 *      `dsh:open` carrying a conversation is somebody saying what they want; the
 *      stored record does not speak, and the open itself writes the new record.
 *   2. A record of the wrong kind for this surface is no record at all.
 *   3. NOTHING IS RESTORED BEFORE THAT SURFACE'S OWN DATA IS READ. Restoring a
 *      conversation before the roster arrives is how a deep link once opened an
 *      agent the person could not reach; here it would paint a dead target.
 *   4. A target that no longer resolves — the conversation was Cleared, the
 *      channel was removed, the unit is gone, the roster changed — falls back to
 *      the surface's own default, silently: nothing failed, so nothing is said.
 *   5. A SURFACE NEVER SHOWS ANOTHER SURFACE'S SELECTION. That is what "the
 *      pane" and "no memory" have to be reconciled with: the center column is
 *      shared, so a surface with nothing of its own either adopts what is
 *      already one of its own targets (a place nobody has clicked since) or
 *      paints its default — never the reflection of the interface you just left.
 * @param input - the surface, its record, and the live data to resolve against.
 * @returns what the caller should paint.
 */
export function planRestore(input: RestoreInputs): RestorePlan {
  const { surface, place } = input
  // 1. The address first, before anything else is even looked at.
  if (input.addressed !== null) return { action: 'addressed' }
  // 2. No record: either this surface is already where the person left it, or
  //    the pane is showing the other interface's place and must be corrected.
  if (place === null) return planWithoutRecord(input)
  if (!PLACE_KINDS[surface].includes(place.kind)) return { action: 'none' }
  // 3. The surface's own data has to be here before a target can be resolved
  //    against it (a wait, not a failure).
  if (!input.ready) return { action: 'wait' }
  switch (place.kind) {
    case 'agent': {
      const row = input.rows.find(candidate => candidate.agent === place.id)
      // The row is the proof this person may open that agent; a conversation the
      // person cleared has no session any more, and there is nothing to reopen.
      if (row === undefined || row.enabled === false || row.sessionId === null) return { action: 'default' }
      // Already painted: nothing to restore, and nothing to spend. This is the
      // "restored exactly once" half of a round trip.
      if (row.sessionId === input.current) return { action: 'none' }
      // The pane can only show a session the client's mirror carries; a list
      // that has not arrived is not a missing conversation.
      if (!input.listed.includes(row.sessionId)) return { action: 'wait' }
      return { action: 'agent', sessionId: row.sessionId }
    }
    case 'channel': {
      // No channel list yet is "unknown", not "removed" — the channel read is
      // its own request and lands after the rows do.
      if (input.channelIds.length === 0) return { action: 'wait' }
      if (!input.channelIds.includes(place.id)) return { action: 'default' }
      return { action: 'channel', id: place.id }
    }
    case 'worker': {
      const row = input.workers.find(candidate => candidate.id === place.id)
      // A damaged row is a statement, not a door: the runtime would refuse the
      // address, so it is the same as a unit that is gone.
      if (row === undefined || row.damaged || row.mode === undefined) return { action: 'default' }
      if (row.id === input.current) return { action: 'none' }
      return { action: 'worker', id: place.id }
    }
  }
}

/**
 * The decision when this surface has no record: adopt its own place if that is
 * what the pane is already painting, keep the shell when nothing is painted, and
 * otherwise paint the surface's default.
 * @param input - the surface and the live data.
 * @returns what the caller should paint.
 */
function planWithoutRecord(input: RestoreInputs): RestorePlan {
  // Whose selection the pane is painting cannot be told before the surface's own
  // data is here; that is a wait, not an empty hand.
  if (!input.ready) return { action: 'wait' }
  if (input.current === undefined || input.current === null) return { action: 'none' }
  if (input.surface === 'epsilons') {
    const worker = input.workers.find(row => row.id === input.current)
    if (worker !== undefined && !worker.damaged && worker.mode !== undefined) {
      return { action: 'adopt', kind: 'worker', id: worker.id }
    }
    return { action: 'default' }
  }
  const row = input.rows.find(candidate => candidate.sessionId === input.current)
  if (row !== undefined) return { action: 'adopt', kind: 'agent', id: row.agent }
  return { action: 'default' }
}

/** Re-exported so a caller can name a surface without importing two modules. */
export type { HarnessSurface }
/** The surfaces this memory covers, in the order the shell defines them. */
export const MEMORY_SURFACES = SURFACES
