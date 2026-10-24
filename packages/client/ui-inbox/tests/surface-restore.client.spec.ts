// @vitest-environment jsdom
/**
 * EACH INTERFACE REMEMBERS ITS OWN PLACE — the restore, driven through the real
 * plugin over a real cordis Context.
 *
 * Owen, 2026-10-24: "when switching between Delta/Epsilon views always default
 * the last known read/write inbox session or agent channel for the Delta view.
 * And default to the last known Epsilon read only session for the Epsilon
 * view." The composed proof of that sentence lives in e-server's browser fixture
 * (tests/surface-memory.journey.mjs — the only surface that runs the real
 * shell). This file is the same claims one layer in, where a fake sessions
 * service can be watched directly: every case asserts WHAT MOVED (`sessions.
 * open`, `openSubagent`, `layout.openPage`, `sessions.clear`) and HOW MANY TIMES,
 * because "restores each side exactly once" is a count, not a feeling.
 *
 * The cases map onto the ticket's own list:
 *   (a) Delta: open Darwin, leave for Epsilons, come back -> Darwin, once.
 *   (b) Delta: a channel comes back as a channel, never as a conversation.
 *   (c) Epsilons: a unit comes back, by the same address a click uses.
 *   (d) A reload lands in the same place in both cases.
 *   (e) A target cleared in between falls back to the surface default, silently.
 *   (f) An explicit address beats the record and then becomes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { InboxInjected } from '../src/client/slots.ts'
import { PLACES_KEY } from '../src/client/surface-memory.ts'

const sid = (id: string): SessionId => id as SessionId

/** One inbox row in the wire shape the e-server sends. */
const row = (agent: string, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  agent, name: agent, hasConversation: true, sessionId: 's-' + agent, blank: false,
  lastActivityAt: 100, running: false, enabled: true, disabled: false,
  presence: 'online', completion: 0, ...overrides,
})

/** The household's roster for the person every case signs in as. */
const HOUSEHOLD = [row('delta'), row('darwin'), row('diana')]

/** One channel the origin offers. */
const CHANNEL = { id: 'c-delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }

/** The person the server resolves from the browser's own cookie. */
const PERSON = 'p-1'

/** One catalog entry, shaped exactly as the harness's `subagent.list` answers. */
type CatalogEntry = SessionListState['subagentsByParent'][SessionId]['entries'][number]

/** The records storage holds for this person, as they are written. */
function records(): Record<string, unknown> {
  const stored = JSON.parse(localStorage.getItem(PLACES_KEY) ?? '{}') as Record<string, unknown>
  return (stored[PERSON] ?? {}) as Record<string, unknown>
}

/** Seed the record store the way a previous visit would have left it. */
function seed(places: Record<string, unknown>): void {
  localStorage.setItem(PLACES_KEY, JSON.stringify({ [PERSON]: places }))
}

/** A session list the refresh verb can populate, as the host's broadcast would. */
function sessionList() {
  const store = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready',
    subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  return {
    store,
    add: (id: string, overrides: Partial<SessionSummary> = {}) => {
      const snapshot = store.getSnapshot()
      const summary: SessionSummary = {
        id: sid(id), displayTitle: id, running: false, blank: true, updatedAt: 0, ...overrides,
      }
      store.set({
        ...snapshot,
        ids: snapshot.ids.includes(sid(id)) ? snapshot.ids : [...snapshot.ids, sid(id)],
        byId: { ...snapshot.byId, [sid(id)]: summary },
      })
    },
    /** Put one parent's catalog on the session list, as the runtime projects it. */
    catalog: (parentId: string, entries: readonly CatalogEntry[]) => {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        subagentsByParent: {
          ...snapshot.subagentsByParent,
          [sid(parentId)]: { entries, parentAvailable: true, state: 'ready', error: null },
        },
      })
    },
  }
}

/** One unit of Delta's catalog. */
const child = (id: string): CatalogEntry => ({
  kind: 'child', id: sid(id), mode: 'continuable', label: `task ${id}`,
  activity: 'inactive', hasChildren: false,
})

interface BenchOptions {
  /** `location.hash` for this page load. */
  readonly hash?: string
  /** The inbox rows the origin answers with. */
  readonly agents?: readonly Record<string, unknown>[]
  /** The channels the origin offers. */
  readonly channels?: readonly unknown[]
  /** Session ids the client's mirror already carries at boot. */
  readonly listed?: readonly string[]
  /** Delta's catalog: the units the Epsilon interface lists. */
  readonly workers?: readonly string[]
  /** The conversation the runtime had selected at boot (its own persistence). */
  readonly current?: string
}

/**
 * Boot the plugin the way a page load does: a fragment, a fake sessions service,
 * the layout face, and the origin's own answers.
 * @param options - what this page load sees.
 * @returns the recorders every case asserts on.
 */
async function bench(options: BenchOptions = {}) {
  window.location.hash = options.hash ?? ''
  const sessions = sessionList()
  const opened: string[] = []
  const workerAddresses: { parentSessionId: string; childSessionId: string; mode: string }[] = []
  const pages: (string | null)[] = []
  let cleared = 0
  const agents = options.agents ?? HOUSEHOLD
  for (const id of options.listed ?? []) sessions.add(id)
  if (options.current !== undefined) {
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid(options.current) })
  }
  if (options.workers !== undefined) sessions.catalog('s-delta', options.workers.map(child))
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('layout', { openPage: (id: string | null) => { pages.push(id) } })
  ctx.provide('sessions', {
    list: sessions.store,
    // The concrete runtime's wire-pump verb: the host's broadcast is what puts
    // a conversation the origin created into the mirror.
    refresh: async () => {
      for (const agent of agents) {
        const sessionId = agent.sessionId
        if (typeof sessionId === 'string') sessions.add(sessionId)
      }
    },
    open: (id: SessionId) => {
      opened.push(id)
      sessions.store.set({ ...sessions.store.getSnapshot(), current: id })
    },
    openSubagent: (address: { parentSessionId: SessionId; childSessionId: SessionId; mode: string }) => {
      workerAddresses.push(address)
      sessions.store.set({ ...sessions.store.getSnapshot(), current: address.childSessionId })
    },
    refreshSubagents: async () => {},
    clear: () => {
      cleared += 1
      sessions.store.set({ ...sessions.store.getSnapshot(), current: undefined })
    },
  })
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'conversation.page': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  vi.stubGlobal('fetch', vi.fn((input: string, init?: RequestInit) => {
    let body: unknown = { person: { id: PERSON, name: 'Person One' }, agents }
    if (input.endsWith('/channels')) body = { channels: options.channels ?? [] }
    else if (input.includes('/channels/')) body = { messages: [] }
    else if (input.endsWith('/open')) {
      const asked = JSON.parse(String(init?.body ?? '{}')) as { agent?: string }
      const agent = asked.agent ?? 'delta'
      const sessionId = 's-' + agent
      // The host created or reused the conversation and broadcast it, which is
      // what the client's mirror learns on the same frame.
      sessions.add(sessionId)
      body = { agent, sessionId, created: false, blank: true, lastActivityAt: null }
    } else if (input.endsWith('/clear')) {
      body = {
        agent: 'delta', hasConversation: false, sessionId: null, blank: true,
        lastActivityAt: null, cleared: true,
      }
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx, fiber, sessions, opened, workerAddresses, pages, clearedFlag: () => cleared,
    face: (): InboxInjected => ctx.slots.entries('sidebar.workspaces')[0]?.inject?.() as unknown as InboxInjected,
  }
}

/**
 * Stand in for the embedding page: jsdom runs every suite as a top-level
 * document, so `window.parent` is the window itself and the plugin would
 * (correctly) attach to nothing. This is the frame's view of its parent, and the
 * only way to move the app between its interfaces without a page load.
 */
function installParent() {
  const posted: { message: unknown; targetOrigin: string }[] = []
  const parent = {
    postMessage: (message: unknown, targetOrigin: string): void => { posted.push({ message, targetOrigin }) },
  }
  const original = Object.getOwnPropertyDescriptor(globalThis, 'parent')
  Object.defineProperty(globalThis, 'parent', { value: parent, configurable: true })
  const send = (data: unknown): void => {
    globalThis.dispatchEvent(new MessageEvent('message', {
      data, origin: 'http://easter.test', source: parent as never,
    }))
  }
  const restore = (): void => {
    if (original === undefined) delete (globalThis as { parent?: unknown }).parent
    else Object.defineProperty(globalThis, 'parent', original)
  }
  return { posted, parent, send, restore }
}

/** The parent asking the app to show one interface, as the e-server page does. */
const show = (surface: 'inbox' | 'epsilons', conversation: string | null = null) =>
  ({ type: 'dsh:open', surface, conversation, token: 'travel-' + surface })

/** Let the microtask/network answers of a boot land. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 40))
}

beforeEach(() => { localStorage.clear() })
afterEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('(a) the Delta surface returns to the conversation you left', () => {
  it('comes back to Darwin after a trip to Epsilons, and restores it exactly once', async () => {
    const wire = installParent()
    try {
      const b = await bench()
      await b.fiber.await()
      const face = b.face()
      face.open('darwin')
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-darwin']) })
      // The record is written at the door the click goes through…
      expect(records()).toEqual({ inbox: { kind: 'agent', id: 'darwin', at: expect.any(Number) } })
      // …and not rewritten by the traffic that follows it: a refresh of the
      // roster must not look like a move.
      const written = localStorage.getItem(PLACES_KEY)
      await b.sessions.store.getSnapshot()
      expect(localStorage.getItem(PLACES_KEY)).toBe(written)

      wire.send(show('epsilons'))
      await settle()
      expect(face.surface.getSnapshot().surface).toBe('epsilons')

      wire.send(show('inbox'))
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-darwin', 's-darwin']) })
      // Exactly once: the data that follows the switch (a rows write, a session
      // frame) must not navigate the person a second time.
      await settle()
      face.load()
      await settle()
      expect(b.opened).toHaveLength(2)
    } finally { wire.restore() }
  })

  it('adopts a conversation that is already open and remembers it for the next trip', async () => {
    const wire = installParent()
    try {
      // The runtime's own persisted selection: where a person who has not
      // clicked since this build landed still is. It is a listed session, since
      // that is what the runtime restores a selection FROM.
      const b = await bench({ current: 's-diana', listed: ['s-delta', 's-diana'] })
      await b.fiber.await()
      expect(records()).toEqual({ inbox: { kind: 'agent', id: 'diana', at: expect.any(Number) } })
      expect(b.opened).toEqual([])
      // Now a trip away and back has something to come back to.
      wire.send(show('epsilons'))
      await settle()
      wire.send(show('inbox'))
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-diana']) })
    } finally { wire.restore() }
  })
})

describe('(b) the Delta surface returns to the channel as a channel', () => {
  it('reopens the channel page, never a conversation', async () => {
    const wire = installParent()
    try {
      const b = await bench({ channels: [CHANNEL] })
      await b.fiber.await()
      const face = b.face()
      await vi.waitFor(() => { expect(face.hooks.channels.getSnapshot().rows).toHaveLength(1) })
      const before = b.pages.length
      face.openChannel(CHANNEL.id)
      await settle()
      expect(face.hooks.channels.getSnapshot().selected?.id).toBe(CHANNEL.id)
      expect(b.pages.slice(before)).toContain('agent-channel')
      expect(records()).toEqual({ inbox: { kind: 'channel', id: CHANNEL.id, at: expect.any(Number) } })

      wire.send(show('epsilons'))
      await settle()
      const away = b.pages.length
      wire.send(show('inbox'))
      await settle()
      // The page is back, and the channel is the selection when it is painted.
      expect(b.pages.slice(away)).toEqual(['agent-channel'])
      expect(face.hooks.channels.getSnapshot().selected?.id).toBe(CHANNEL.id)
      // A channel is not a conversation: nothing was opened at all.
      expect(b.opened).toEqual([])
    } finally { wire.restore() }
  })
})

describe('(c) the Epsilon surface returns to the unit you were reading', () => {
  it('comes back to the unit, by the same address a click uses', async () => {
    const wire = installParent()
    try {
      const b = await bench({ workers: ['w-1', 'w-2'] })
      await b.fiber.await()
      const face = b.face()
      wire.send(show('epsilons'))
      await vi.waitFor(() => { expect(face.hooks.inbox.getSnapshot().workers).toHaveLength(2) })
      face.openWorker('w-2')
      expect(b.workerAddresses).toEqual([
        { parentSessionId: 's-delta', childSessionId: 'w-2', mode: 'continuable' },
      ])
      expect(records()).toEqual({ epsilons: { kind: 'worker', id: 'w-2', at: expect.any(Number) } })

      wire.send(show('inbox'))
      await settle()
      wire.send(show('epsilons'))
      await vi.waitFor(() => expect(b.workerAddresses).toHaveLength(2))
      // The SAME address: the record stores the id the roster row carries, and
      // the parent and mode are resolved from the live catalog.
      expect(b.workerAddresses[1]).toEqual({ parentSessionId: 's-delta', childSessionId: 'w-2', mode: 'continuable' })
      // And no agent conversation was opened on the way through.
      expect(b.opened).toEqual([])
    } finally { wire.restore() }
  })
})

describe('(d) a reload lands in the same place', () => {
  it('restores the Delta conversation with no click behind it', async () => {
    const first = await bench()
    await first.fiber.await()
    first.face().open('darwin')
    await vi.waitFor(() => { expect(first.opened).toEqual(['s-darwin']) })
    // A reload: the same storage, a whole new boot.
    const second = await bench({ listed: ['s-delta', 's-darwin', 's-diana'] })
    await second.fiber.await()
    await vi.waitFor(() => { expect(second.opened).toEqual(['s-darwin']) })
  })

  it('restores the Epsilon unit with no click behind it', async () => {
    const first = await bench({ workers: ['w-1'] })
    await first.fiber.await()
    const wire = installParent()
    try {
      wire.send(show('epsilons'))
      await vi.waitFor(() => { expect(first.face().hooks.inbox.getSnapshot().workers).toHaveLength(1) })
      first.face().openWorker('w-1')
      expect(first.workerAddresses).toHaveLength(1)
    } finally { wire.restore() }
    // A reload of the Epsilon interface: `#epsilons`, no address, no click.
    const second = await bench({ hash: '#epsilons', workers: ['w-1'], listed: ['s-delta', 'w-1'] })
    await second.fiber.await()
    await vi.waitFor(() => { expect(second.workerAddresses).toHaveLength(1) })
    expect(second.workerAddresses[0]).toEqual({ parentSessionId: 's-delta', childSessionId: 'w-1', mode: 'continuable' })
  })

  it('restores the channel page with no click behind it', async () => {
    seed({ inbox: { kind: 'channel', id: CHANNEL.id, at: 1 } })
    const b = await bench({ channels: [CHANNEL] })
    await b.fiber.await()
    await vi.waitFor(() => { expect(b.pages).toContain('agent-channel') })
    expect(b.face().hooks.channels.getSnapshot().selected?.id).toBe(CHANNEL.id)
    expect(b.opened).toEqual([])
  })
})

describe('(e) a target that was cleared in between falls back, silently', () => {
  it('drops a conversation the person cleared and shows the Delta welcome screen', async () => {
    seed({ inbox: { kind: 'agent', id: 'diana', at: 1 } })
    const b = await bench({
      agents: [row('delta'), row('darwin'), row('diana', { sessionId: null, hasConversation: false, blank: true })],
      listed: ['s-delta', 's-darwin'],
    })
    await b.fiber.await()
    await vi.waitFor(() => { expect(b.clearedFlag()).toBe(1) })
    // Nothing opened, nothing reported: the surface's own default stands.
    expect(b.opened).toEqual([])
    const state = b.face().hooks.inbox.getSnapshot()
    expect(state.notices).toEqual({})
    expect(state.loadError).toBeNull()
    expect(state.status).toBe('ready')
    expect(b.face().hooks.channels.getSnapshot().error).toBeNull()
    // The dead address is retired, so it cannot be re-dropped on every reload.
    expect(records()).toEqual({})
  })

  it('drops a channel the server no longer offers', async () => {
    seed({ inbox: { kind: 'channel', id: 'c-gone', at: 1 } })
    const b = await bench({ channels: [CHANNEL] })
    await b.fiber.await()
    await vi.waitFor(() => { expect(b.clearedFlag()).toBe(1) })
    expect(b.pages).not.toContain('agent-channel')
    expect(b.face().hooks.channels.getSnapshot().error).toBeNull()
    expect(b.face().hooks.channels.getSnapshot().loading).toBe(false)
    expect(records()).toEqual({})
  })

  it('drops a unit Delta no longer lists, and never paints it', async () => {
    const wire = installParent()
    try {
      seed({ epsilons: { kind: 'worker', id: 'w-gone', at: 1 } })
      const b = await bench({ workers: ['w-1'], listed: ['s-delta', 'w-1'] })
      await b.fiber.await()
      wire.send(show('epsilons'))
      await vi.waitFor(() => { expect(b.clearedFlag()).toBe(1) })
      expect(b.workerAddresses).toEqual([])
      expect(b.face().hooks.inbox.getSnapshot().workerNotice).toBeNull()
      expect(records()).toEqual({})
    } finally { wire.restore() }
  })

  it("does not leave the other interface's selection painted under the new one", async () => {
    const wire = installParent()
    try {
      // Delta's place is a unit that is gone, and the pane is painting the Delta
      // conversation: the Epsilon surface must not come up on top of it.
      seed({ inbox: { kind: 'agent', id: 'darwin', at: 1 }, epsilons: { kind: 'worker', id: 'w-gone', at: 1 } })
      const b = await bench({ workers: ['w-1'], listed: ['s-delta', 's-darwin', 'w-1'] })
      await b.fiber.await()
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-darwin']) })
      const before = b.pages.length
      wire.send(show('epsilons'))
      await settle()
      // The pane is cleared and no page is painted: the list is the default.
      expect(b.pages.slice(before)).toEqual([null])
      expect(b.sessions.store.getSnapshot().current).toBeUndefined()
      expect(b.workerAddresses).toEqual([])
    } finally { wire.restore() }
  })
})

describe('(f) an explicit address beats the record, and becomes it', () => {
  it('opens the addressed agent instead of the stored one, then remembers the address', async () => {
    seed({ inbox: { kind: 'agent', id: 'darwin', at: 1 } })
    const b = await bench({ hash: '#c/diana', listed: ['s-delta', 's-darwin'] })
    await b.fiber.await()
    await vi.waitFor(() => { expect(b.opened).toEqual(['s-diana']) })
    // The record did not speak, and it now says what the address said.
    expect(b.opened).not.toContain('s-darwin')
    expect(records()).toEqual({ inbox: { kind: 'agent', id: 'diana', at: expect.any(Number) } })
  })

  it('lets a message-carried address win over the record on its surface too', async () => {
    const wire = installParent()
    try {
      seed({ inbox: { kind: 'agent', id: 'darwin', at: 1 } })
      const b = await bench({ listed: ['s-delta', 's-darwin', 's-diana'] })
      await b.fiber.await()
      // The boot restore lands first, with no address in force.
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-darwin']) })
      // Then the parent names an exact entry point: that is somebody saying what
      // they want, and it wins without a second restore fighting it.
      wire.send(show('inbox', 'diana'))
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-darwin', 's-diana']) })
      expect(records()).toEqual({ inbox: { kind: 'agent', id: 'diana', at: expect.any(Number) } })
    } finally { wire.restore() }
  })

  it('keeps the address even when the surface flips in the same message', async () => {
    const wire = installParent()
    try {
      seed({ inbox: { kind: 'agent', id: 'darwin', at: 1 } })
      const b = await bench({ listed: ['s-delta', 's-darwin', 's-diana'] })
      await b.fiber.await()
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-darwin']) })
      wire.send(show('epsilons'))
      await settle()
      // One message that both returns to Delta and names an agent: the address is
      // queued before the surface is published, so the restore stands aside.
      const before = b.opened.length
      wire.send(show('inbox', 'diana'))
      await vi.waitFor(() => { expect(b.opened).toEqual(['s-darwin', 's-diana']) })
      expect(b.opened).toHaveLength(before + 1)
    } finally { wire.restore() }
  })
})

describe('the record is per (person, surface), and mismatched kinds are no record', () => {
  it("never restores one person's place for another", async () => {
    // The record belongs to somebody else on this browser.
    localStorage.setItem(PLACES_KEY, JSON.stringify({ hannah: { inbox: { kind: 'agent', id: 'diana', at: 1 } } }))
    const b = await bench({ listed: ['s-delta', 's-darwin', 's-diana'] })
    await b.fiber.await()
    await settle()
    expect(b.opened).toEqual([])
    expect(b.clearedFlag()).toBe(0)
  })

  it('reads a record of the other surface as nothing to restore', async () => {
    // A worker address on the Delta surface (a corruption an older build, a hand
    // edit or a half-written entry could leave behind).
    seed({ inbox: { kind: 'worker', id: 'w-1', at: 1 } })
    const b = await bench({ workers: ['w-1'], listed: ['s-delta', 'w-1'] })
    await b.fiber.await()
    await settle()
    expect(b.opened).toEqual([])
    expect(b.workerAddresses).toEqual([])
    // Not a dead target either: the surface is left exactly as it was.
    expect(b.clearedFlag()).toBe(0)
    expect(records()).toEqual({ inbox: { kind: 'worker', id: 'w-1', at: 1 } })
  })
})
