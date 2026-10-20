// @vitest-environment jsdom
/**
 * ui-inbox on a real cordis Context: the browser half registers ONE occupant
 * for `sidebar.workspaces` (no competing rank, because ui-workspace is no
 * longer composed), serves the panel through the inject face, reads the inbox
 * on boot without throwing when the API misbehaves, and gives the rows' open
 * verb the sessions service as its navigation seam.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as nodeApply } from '../src/index.ts'
import { apply as invariantApply, inject as invariantInject, name as invariantName } from '../src/invariant.ts'
import { apply, inject } from '../src/client/index.ts'
import type { InboxInjected } from '../src/client/slots.ts'

const sid = (id: string): SessionId => id as SessionId

/** A session list with no rows until a test adds one, carrying the runtime's summary fields. */
function sessionList() {
  const store = createSnapshotStore<SessionListState>({
    ids: [],
    byId: {},
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  return {
    store,
    add: (id: string, overrides: Partial<SessionSummary> = {}) => {
      const snapshot = store.getSnapshot()
      const summary: SessionSummary = {
        id: sid(id), displayTitle: id, running: false, blank: true, updatedAt: 0, ...overrides,
      }
      const listed = snapshot.ids.includes(sid(id))
      store.set({
        ...snapshot,
        ids: listed ? snapshot.ids : [...snapshot.ids, sid(id)],
        byId: { ...snapshot.byId, [sid(id)]: summary },
      })
    },
  }
}

/**
 * Boot the plugin over a real slot ledger and a fake sessions service.
 * @param listBody - what the stubbed inbox list endpoint answers.
 * @param options - the channel list the origin offers, when a test needs one.
 */
async function bench(listBody: unknown = {
  person: { id: 'p-1', name: 'Person One' },
  agents: [{
    agent: 'agent-a', name: 'Alpha', hasConversation: true,
    sessionId: 's-a', blank: false, lastActivityAt: 100, running: false,
    enabled: true, disabled: false, presence: 'online', completion: 0,
  }],
}, options: { channels?: readonly unknown[] } = {}) {
  const sessions = sessionList()
  const opened: string[] = []
  let cleared = false
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const openPage = vi.fn()
  ctx.provide('layout', { openPage })
  ctx.provide('sessions', {
    list: sessions.store,
    // The concrete runtime's wire-pump verb: the fixture answers it the way the
    // host would — the created conversation appears in the mirror.
    refresh: async () => { sessions.add('s-a') },
    open: (id: SessionId) => { opened.push(id) },
    clear: () => { cleared = true },
  })
  ctx.slots.register({
    name: 'root',
    children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' }, 'conversation.page': { kind: 'list', scope: 'root' } },
  } as never, (() => null) as never)
  const fetches: string[] = []
  // One canned answer per endpoint: the payloads genuinely differ, and a
  // list body answered for /open would parse as malformed.
  const fetchStub = vi.fn((input: string) => {
    fetches.push(input)
    let body: unknown = listBody
    if (input.endsWith('/channels')) {
      body = { channels: options.channels ?? [] }
    } else if (input.includes('/channels/')) {
      body = { messages: [] }
    } else if (input.endsWith('/open')) {
      body = { agent: 'agent-a', sessionId: 's-a', created: false, blank: true, lastActivityAt: null }
    } else if (input.endsWith('/clear')) {
      body = {
        agent: 'agent-a', hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true,
      }
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  })
  vi.stubGlobal('fetch', fetchStub)
  const fiber = ctx.plugin({ inject: [...inject], apply })
  return {
    ctx, fiber, sessions, opened, fetches, openPage,
    clearedFlag: () => cleared,
    entry: () => ctx.slots.entries('sidebar.workspaces')[0],
  }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals() })

describe('ui-inbox registration', () => {
  it('occupies sidebar.workspaces as its only registrant, at no special rank', async () => {
    const b = await bench()
    await b.fiber.await()
    const entries = b.ctx.slots.entries('sidebar.workspaces')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.locale).toBe('inbox')
    // No shadowing rank: ui-workspace is out of the composition entirely, so a
    // same-priority collision cannot arise.
    expect(entries[0]?.options.priority).toBeUndefined()
    expect(b.entry()?.inject).toBeTypeOf('function')
  })

  it('publishes the snapshot through the hooks compartment and the three verbs', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()?.inject?.() as unknown as InboxInjected
    expect(face.hooks.inbox.getSnapshot().rows.map(row => row.agent)).toEqual(['agent-a'])
    expect(face.hooks.inbox.getSnapshot().status).toBe('ready')
    expect(face.load).toBeTypeOf('function')
    expect(face.open).toBeTypeOf('function')
    expect(face.clear).toBeTypeOf('function')
  })

  it('publishes the count of conversations running below each row', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()?.inject?.() as unknown as InboxInjected
    // The frame that starts a subagent, in the shape the runtime projects it.
    b.sessions.add('s-a')
    b.sessions.add('s-sub', { parentId: sid('s-a'), origin: 'subagent', running: true })
    await vi.waitFor(() => {
      expect(face.hooks.inbox.getSnapshot().activeSubagents).toEqual({ 'agent-a': 1 })
    })
  })

  it('reads the inbox from the origin root path on boot', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.fetches).toEqual(['/v1/browser/inbox/channels', '/v1/browser/inbox'])
  })

  it('degrades to a visible failure instead of throwing when the API is unreachable', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()?.inject?.() as unknown as InboxInjected
    // The boot read succeeded; now the API goes away under the panel.
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    face.load()
    await vi.waitFor(() => {
      const state = face.hooks.inbox.getSnapshot()
      expect(state.status).toBe('error')
      expect(state.loadError).toBe('transport')
    })
  })

  it('navigates a row click to the session the server returned', async () => {
    const b = await bench()
    await b.fiber.await()
    const face = b.entry()?.inject?.() as unknown as InboxInjected
    face.open('agent-a')
    await vi.waitFor(() => { expect(b.opened).toEqual(['s-a']) })
    expect(b.fetches).toEqual(['/v1/browser/inbox/channels', '/v1/browser/inbox', '/v1/browser/inbox/open'])
  })

  it('fails at registration, not on the first click, when the runtime lost sessions.refresh', async () => {
    // The typed ISessions face does not declare refresh (see the README); this
    // asserts the loud seam check that keeps that divergence from becoming a
    // TypeError somewhere under a row click.
    const ctx = new Context()
    await ctx.plugin(SlotRegistry).await()
    ctx.provide('locale', new LocaleRuntime(ctx))
    ctx.provide('layout', { openPage: vi.fn() })
    ctx.provide('sessions', {
      list: sessionList().store,
      open: () => {},
      clear: () => {},
    })
    ctx.slots.register({
      name: 'root',
      children: { 'sidebar.workspaces': { kind: 'single', scope: 'root' }, 'conversation.page': { kind: 'list', scope: 'root' } },
    } as never, (() => null) as never)
    // cordis re-raises the activation throw on its loud channel as well; the
    // assertion below is the contract, the handler keeps the run clean.
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await expect(ctx.plugin({ inject: [...inject], apply }).await())
        .rejects.toThrow(/no longer exposes sessions\.refresh/)
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(rejections.map(String).join('\n')).toContain('no longer exposes sessions.refresh')
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('drops the panel when the plugin fiber unloads (HMR safety)', async () => {
    const b = await bench()
    await b.fiber.await()
    expect(b.entry()).toBeDefined()
    await b.fiber.dispose()
    expect(b.entry()).toBeUndefined()
  })
})

describe('ui-inbox channel restore (where you were, channel half)', () => {
  const channelRow = { id: 'c-delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }

  it('reopens the channel that was open and selects its page in one step', async () => {
    // A reload: the id survived in localStorage, no click exists yet.
    localStorage.setItem('dsh.inbox.channel', JSON.stringify({ channelId: channelRow.id }))
    const b = await bench(undefined, { channels: [channelRow] })
    await b.fiber.await()
    const face = b.entry()?.inject?.() as unknown as InboxInjected
    await vi.waitFor(() => { expect(b.openPage).toHaveBeenCalledWith('agent-channel') })
    // ui-inbox is the single writer of the channel page: the selection is
    // already the channel when the page is selected, so nothing paints the
    // agent conversation first and corrects itself a frame later.
    expect(face.hooks.channels.getSnapshot().selected?.id).toBe(channelRow.id)
    expect(b.openPage).toHaveBeenCalledTimes(1)
  })

  it('leaves the conversation default in place when the persisted channel is gone', async () => {
    localStorage.setItem('dsh.inbox.channel', JSON.stringify({ channelId: 'cleared-elsewhere' }))
    const b = await bench(undefined, { channels: [channelRow] })
    await b.fiber.await()
    const face = b.entry()?.inject?.() as unknown as InboxInjected
    await vi.waitFor(() => { expect(face.hooks.channels.getSnapshot().rows).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.openPage).not.toHaveBeenCalled()
    expect(face.hooks.channels.getSnapshot().selected).toBeNull()
    expect(face.hooks.channels.getSnapshot().error).toBeNull()
    expect(JSON.parse(localStorage.getItem('dsh.inbox.channel')!)).toEqual({ channelId: null })
  })

  it('does not restore anything when no channel was open', async () => {
    const b = await bench(undefined, { channels: [channelRow] })
    await b.fiber.await()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(b.openPage).not.toHaveBeenCalled()
  })
})

describe('ui-inbox node half and invariant companion', () => {
  it('has no host-side behavior', () => {
    // A pure UI plugin's node half exists only so the Loader has a body to
    // activate; it returns nothing and touches nothing.
    expect(nodeApply).toHaveLength(0)
  })

  it('reserves package ownership without installing a runtime invariant', async () => {
    expect(invariantName).toBe('client-ui-inbox-invariant')
    expect(invariantInject).toEqual(['invariants'])
    const register = vi.fn(() => () => {})
    const dispose = await invariantApply({ invariants: { register } } as never)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-inbox', expect.any(Function))
    expect(dispose).toBeTypeOf('function')
  })
})
