// @vitest-environment jsdom
/**
 * WHERE YOU WERE, one record per (person, surface) — the record's shape, its
 * storage, and the decision that turns it into a paint.
 *
 * Owen, 2026-10-24: "when switching between Delta/Epsilon views always default
 * the last known read/write inbox session or agent channel for the Delta view.
 * And default to the last known Epsilon read only session for the Epsilon
 * view." The two claims this file holds down, in the order the ticket states
 * them:
 *
 *   1. THE RECORD: `{ kind, id, at }`, one per (person, surface), persisted with
 *      the store engine's own `persist` so it survives a reload, and keyed by
 *      person so one household member's place is never restored for another.
 *   2. THE DECISION (`planRestore`): an explicit address beats the record; the
 *      record's kind decides which surface may use it; nothing is resolved
 *      before that surface's own data is read; a target that is gone falls back
 *      to the surface's own default instead of painting it.
 *
 * The composed proof — the real shell, real switching, real reloads — is
 * tests/surface-memory.journey.mjs through e-server's browser fixture; this file
 * is the part that can be read as a rule.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_CHANNEL_KEY, PLACES_KEY, SurfaceMemory, placeFor, placeIn, planRestore,
  type PlaceAgentRow, type PlaceWorkerRow, type RestoreInputs, type SurfacePlace,
} from '../src/client/surface-memory.ts'
import type { InboxWorkerRow } from '../src/client/inbox-controller.ts'

const NOW = 1_792_800_000_000

/** The two people this browser can be, as the server names them. */
const OWEN = 'owen'
const HANNAH = 'hannah'

/** A place as it is written to storage. */
const place = (kind: SurfacePlace['kind'], id: string, at = NOW): SurfacePlace => ({ kind, id, at })

beforeEach(() => { localStorage.clear() })

describe('the record: one per (person, surface), durable, person-scoped', () => {
  it('writes a record per surface and reads each one back', () => {
    const memory = new SurfaceMemory()
    expect(memory.remember(OWEN, 'inbox', 'agent', 'darwin', NOW)).toBe(true)
    expect(memory.remember(OWEN, 'epsilons', 'worker', 'w-1', NOW)).toBe(true)
    // Delta keeps the conversation or the channel; Epsilons keeps the unit.
    expect(memory.placeOf(OWEN, 'inbox')).toEqual(place('agent', 'darwin'))
    expect(memory.placeOf(OWEN, 'epsilons')).toEqual(place('worker', 'w-1'))
  })

  it('survives a reload, because the store engine persists it', () => {
    new SurfaceMemory().remember(OWEN, 'inbox', 'agent', 'darwin', NOW)
    // A fresh instance is what a page load is: same storage, new closures.
    const reloaded = new SurfaceMemory()
    expect(reloaded.placeOf(OWEN, 'inbox')).toEqual(place('agent', 'darwin'))
    expect(JSON.parse(localStorage.getItem(PLACES_KEY)!)).toEqual({
      [OWEN]: { inbox: { kind: 'agent', id: 'darwin', at: NOW } },
    })
  })

  it('never hands one person the place another person left', () => {
    const memory = new SurfaceMemory()
    memory.remember(OWEN, 'inbox', 'channel', 'c-delta-darwin', NOW)
    memory.remember(HANNAH, 'inbox', 'agent', 'diana', NOW)
    expect(memory.placeOf(OWEN, 'inbox')?.id).toBe('c-delta-darwin')
    expect(memory.placeOf(HANNAH, 'inbox')?.id).toBe('diana')
    // Somebody with no record of their own gets none of somebody else's.
    expect(memory.placeOf('quinn', 'inbox')).toBeNull()
    expect(memory.placeOf(null, 'inbox')).toBeNull()
  })

  it('records nothing for a person the server has not resolved yet', () => {
    const memory = new SurfaceMemory()
    expect(memory.remember(null, 'inbox', 'agent', 'darwin', NOW)).toBe(false)
    expect(localStorage.getItem(PLACES_KEY)).toBeNull()
  })

  it('refuses to record a kind the surface could never restore', () => {
    const memory = new SurfaceMemory()
    // A channel on the Epsilon surface would be dropped on the way back in;
    // writing it would only teach the store a lie.
    expect(memory.remember(OWEN, 'epsilons', 'channel', 'c-1', NOW)).toBe(false)
    expect(memory.placeOf(OWEN, 'epsilons')).toBeNull()
  })

  it('does not rewrite a record that already says where the person is', () => {
    const memory = new SurfaceMemory()
    expect(memory.remember(OWEN, 'inbox', 'agent', 'darwin', NOW)).toBe(true)
    expect(memory.remember(OWEN, 'inbox', 'agent', 'darwin', NOW + 5_000)).toBe(false)
    // The arrival time stays the one that describes the move.
    expect(memory.placeOf(OWEN, 'inbox')?.at).toBe(NOW)
  })

  it('forgets one surface without touching the other', () => {
    const memory = new SurfaceMemory()
    memory.remember(OWEN, 'inbox', 'agent', 'darwin', NOW)
    memory.remember(OWEN, 'epsilons', 'worker', 'w-1', NOW)
    expect(memory.forget(OWEN, 'inbox')).toBe(true)
    expect(memory.placeOf(OWEN, 'inbox')).toBeNull()
    expect(memory.placeOf(OWEN, 'epsilons')).toEqual(place('worker', 'w-1'))
  })

  it('treats storage it did not write as no record at all', () => {
    // Hand-edited, half-written and cross-build entries are all the same answer.
    for (const stored of [
      { [OWEN]: { inbox: { kind: 'channel', id: 'c-1' } } },             // no `at`
      { [OWEN]: { inbox: { kind: 'worker', id: 'w-1', at: NOW } } },     // wrong surface
      { [OWEN]: { inbox: { kind: 'agent', id: '', at: NOW } } },         // no id
      { [OWEN]: { inbox: { kind: 'agent', id: 'darwin', at: 'soon' } } },// bad clock
      { [OWEN]: { inbox: 'darwin' } },                                   // not a record
      { [OWEN]: { inbox: null } },
      'not an object at all',
    ]) {
      localStorage.setItem(PLACES_KEY, JSON.stringify(stored))
      expect(new SurfaceMemory().placeOf(OWEN, 'inbox'), JSON.stringify(stored)).toBeNull()
    }
  })

  it('reads the kind table as the type of the record, not as a hint', () => {
    expect(placeFor('inbox', place('agent', 'darwin'))).toEqual(place('agent', 'darwin'))
    expect(placeFor('inbox', place('channel', 'c-1'))).toEqual(place('channel', 'c-1'))
    expect(placeFor('inbox', place('worker', 'w-1'))).toBeNull()
    expect(placeFor('epsilons', place('worker', 'w-1'))).toEqual(place('worker', 'w-1'))
    expect(placeFor('epsilons', place('agent', 'darwin'))).toBeNull()
    expect(placeFor('epsilons', place('channel', 'c-1'))).toBeNull()
    expect(placeIn({ [OWEN]: { inbox: place('worker', 'w-1') } }, OWEN, 'inbox')).toBeNull()
  })
})

describe('the retired channel key is adopted once, and never resurrects a dead id', () => {
  it('adopts the channel the previous build remembered, for the person signed in now', () => {
    localStorage.setItem(LEGACY_CHANNEL_KEY, JSON.stringify({ channelId: 'c-delta-darwin' }))
    const memory = new SurfaceMemory()
    expect(memory.adoptLegacyChannel(OWEN, ['c-delta-darwin', 'c-delta-diana'])).toBe(true)
    // Stamped with the adoption (the old entry carried no clock), so only the
    // address and the kind are the legacy key's to say.
    expect(memory.placeOf(OWEN, 'inbox')).toMatchObject({ kind: 'channel', id: 'c-delta-darwin' })
    // The key is retired: the next person on this browser inherits nothing.
    expect(localStorage.getItem(LEGACY_CHANNEL_KEY)).toBeNull()
    expect(memory.adoptLegacyChannel(HANNAH, ['c-delta-darwin'])).toBe(false)
    expect(memory.placeOf(HANNAH, 'inbox')).toBeNull()
  })

  it('drops an id the server no longer offers instead of resurrecting it', () => {
    localStorage.setItem(LEGACY_CHANNEL_KEY, JSON.stringify({ channelId: 'gone-channel' }))
    const memory = new SurfaceMemory()
    expect(memory.adoptLegacyChannel(OWEN, ['c-delta-darwin'])).toBe(false)
    expect(memory.placeOf(OWEN, 'inbox')).toBeNull()
    expect(localStorage.getItem(LEGACY_CHANNEL_KEY)).toBeNull()
  })

  it('waits while the channel list is unknown, and never overrules a real record', () => {
    localStorage.setItem(LEGACY_CHANNEL_KEY, JSON.stringify({ channelId: 'c-delta-darwin' }))
    const memory = new SurfaceMemory()
    // An unknown list is not an absent channel: the key stays for the next read.
    expect(memory.adoptLegacyChannel(OWEN, [])).toBe(false)
    expect(localStorage.getItem(LEGACY_CHANNEL_KEY)).not.toBeNull()
    // A record this build wrote always wins over a leftover key.
    memory.remember(OWEN, 'inbox', 'agent', 'darwin', NOW)
    expect(memory.adoptLegacyChannel(OWEN, ['c-delta-darwin'])).toBe(false)
    expect(memory.placeOf(OWEN, 'inbox')).toEqual(place('agent', 'darwin'))
    expect(localStorage.getItem(LEGACY_CHANNEL_KEY)).toBeNull()
  })
})

describe('the decision: address, kind, readiness, dead targets', () => {
  const rows: PlaceAgentRow[] = [
    { agent: 'delta', sessionId: 's-delta', enabled: true },
    { agent: 'darwin', sessionId: 's-darwin', enabled: true },
    { agent: 'diana', sessionId: null, enabled: true },
    { agent: 'dexter', sessionId: 's-dexter', enabled: false },
  ]
  const workers: PlaceWorkerRow[] = [
    { id: 'w-1', mode: 'continuable', damaged: false },
    { id: 'w-2', damaged: true },
  ]
  const input = (overrides: Partial<RestoreInputs> = {}): RestoreInputs => ({
    surface: 'inbox',
    place: null,
    addressed: null,
    ready: true,
    rows,
    channelIds: ['c-delta-darwin'],
    workers,
    listed: ['s-delta', 's-darwin', 's-dexter', 'w-1'],
    current: undefined,
    ...overrides,
  })

  it('restores the conversation the Delta record names', () => {
    expect(planRestore(input({ place: place('agent', 'darwin') })))
      .toEqual({ action: 'agent', sessionId: 's-darwin' })
  })

  it('restores the channel the Delta record names', () => {
    expect(planRestore(input({ place: place('channel', 'c-delta-darwin') })))
      .toEqual({ action: 'channel', id: 'c-delta-darwin' })
  })

  it('restores the unit the Epsilon record names, by the address a click uses', () => {
    expect(planRestore(input({ surface: 'epsilons', place: place('worker', 'w-1') })))
      .toEqual({ action: 'worker', id: 'w-1' })
  })

  it('does nothing when that place is already the one on screen', () => {
    // The "exactly once" half of a round trip: no second select, no request.
    expect(planRestore(input({ place: place('agent', 'darwin'), current: 's-darwin' })))
      .toEqual({ action: 'none' })
    expect(planRestore(input({ surface: 'epsilons', place: place('worker', 'w-1'), current: 'w-1' })))
      .toEqual({ action: 'none' })
  })

  it('lets an explicit address beat the record, and says so', () => {
    // A cold load of #c/diana while the record says darwin: the address is
    // somebody saying what they want, so the record does not speak at all.
    expect(planRestore(input({ place: place('agent', 'darwin'), addressed: 'diana' })))
      .toEqual({ action: 'addressed' })
    // Even with no record, no data and no rows: the address answers first.
    expect(planRestore(input({ addressed: 'diana', ready: false })))
      .toEqual({ action: 'addressed' })
  })

  it('treats a record of the other surface as no record', () => {
    expect(planRestore(input({ place: place('worker', 'w-1') }))).toEqual({ action: 'none' })
    expect(planRestore(input({ surface: 'epsilons', place: place('channel', 'c-1') })))
      .toEqual({ action: 'none' })
  })

  it('restores nothing before that surface has read its own data', () => {
    // Restoring a conversation before the roster arrives is how a deep link
    // opened an agent the person could not reach.
    expect(planRestore(input({ place: place('agent', 'darwin'), ready: false })))
      .toEqual({ action: 'wait' })
    expect(planRestore(input({ surface: 'epsilons', place: place('worker', 'w-1'), ready: false })))
      .toEqual({ action: 'wait' })
    // And the same holds when there is no record yet, because until the rows
    // land nobody knows whether what is painted belongs to this surface.
    expect(planRestore(input({ ready: false }))).toEqual({ action: 'wait' })
  })

  it('waits for a conversation the session mirror has not listed yet', () => {
    expect(planRestore(input({ place: place('agent', 'darwin'), listed: [] })))
      .toEqual({ action: 'wait' })
    // A channel list that has not arrived is unknown, not removed.
    expect(planRestore(input({ place: place('channel', 'c-delta-darwin'), channelIds: [] })))
      .toEqual({ action: 'wait' })
  })

  it('falls back to the surface default for every kind of dead target', () => {
    // The conversation was Cleared: the row survives, its session does not.
    expect(planRestore(input({ place: place('agent', 'diana') }))).toEqual({ action: 'default' })
    // The person's roster changed: no row for that agent any more.
    expect(planRestore(input({ place: place('agent', 'sol') }))).toEqual({ action: 'default' })
    // The agent is recorded but not enabled on this deployment.
    expect(planRestore(input({ place: place('agent', 'dexter') }))).toEqual({ action: 'default' })
    // The channel was removed from this person's list.
    expect(planRestore(input({ place: place('channel', 'c-gone') }))).toEqual({ action: 'default' })
    // The worker is no longer in Delta's catalog…
    expect(planRestore(input({ surface: 'epsilons', place: place('worker', 'w-9') })))
      .toEqual({ action: 'default' })
    // …or the harness can no longer identify it, so it cannot be addressed.
    expect(planRestore(input({ surface: 'epsilons', place: place('worker', 'w-2') })))
      .toEqual({ action: 'default' })
  })

  it('adopts a place the pane is already painting, and keeps the shell when nothing is', () => {
    // A person who has not clicked since this build landed: their place is the
    // runtime's own persisted selection, and it becomes the record.
    expect(planRestore(input({ current: 's-darwin' })))
      .toEqual({ action: 'adopt', kind: 'agent', id: 'darwin' })
    expect(planRestore(input({ surface: 'epsilons', current: 'w-1' })))
      .toEqual({ action: 'adopt', kind: 'worker', id: 'w-1' })
    expect(planRestore(input({ current: undefined }))).toEqual({ action: 'none' })
  })

  it("never leaves the other interface's selection painted under this one", () => {
    // The pane holds a unit while the Delta surface is showing, and Delta has no
    // record: Delta paints its own default rather than the Epsilon place.
    expect(planRestore(input({ current: 'w-1' }))).toEqual({ action: 'default' })
    // And the mirror image: a Delta conversation under the Epsilon surface.
    expect(planRestore(input({ surface: 'epsilons', current: 's-delta' })))
      .toEqual({ action: 'default' })
  })

  it('reads the roster the way the epsilon list does, damaged rows included', () => {
    // The plan's inputs are the controller's own rows; naming the type here keeps
    // the two shapes from drifting apart silently.
    const roster: InboxWorkerRow[] = [{ id: 'w-1' as never, parentId: 's-delta' as never, index: 1, running: false, mode: 'continuable', damaged: false }]
    expect(planRestore(input({ surface: 'epsilons', place: place('worker', 'w-1'), workers: roster })))
      .toEqual({ action: 'worker', id: 'w-1' })
  })
})
