// @vitest-environment jsdom
/**
 * THE ADDRESSED CONVERSATION: `#c/<agent>` is a real destination, not a mode.
 *
 * Owen, 2026-10-23: the e-server top bar's Delta button "is now a drop down menu
 * ... so instead of taking you directly to the agent harness application you
 * instead always select an exact entry point". Every row of that menu points at
 * `/ai/harness/c/<agent>`, whose frame `src` carries `#c/<agent>`, so the claim
 * this file holds down is the one the whole feature rests on: a page load with
 * that fragment OPENS THAT AGENT'S CONVERSATION — through the same inbox
 * controller door a click uses, not through a second navigation mechanism.
 *
 * The parsing half is pure and tested first, because `#epsilons` has to keep
 * meaning what it meant (the two-interface deployment is live) while `#c/...`
 * acquires a meaning beside it, in the same single reader.
 *
 * The boot half is driven over a real cordis Context and a fake sessions
 * service, exactly like browser-plugin.client.spec.tsx: what is asserted is
 * `sessions.open(id)` — the call that moves the pane — and the `/open` request
 * that produced the id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore, SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import { bootIntentOf, CONVERSATION_FRAGMENT, EPSILONS_FRAGMENT, surfaceOf } from '../src/client/surface.ts'

const sid = (id: string): SessionId => id as SessionId

/** One inbox row in the wire shape the e-server sends. */
const row = (agent: string, overrides: Record<string, unknown> = {}) => ({
  agent, name: agent, hasConversation: true, sessionId: 's-' + agent, blank: true,
  lastActivityAt: null, running: false, enabled: true, disabled: false,
  presence: 'online', completion: 0, ...overrides,
})

/** A session list the refresh verb can populate, as the host's broadcast would. */
function sessionList() {
  const store = createSnapshotStore<SessionListState>({
    ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {},
    jobsBySession: {}, currentAddress: undefined,
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
  }
}

/**
 * Boot the plugin as a page load at `hash`.
 * @param hash - `location.hash` for this load, e.g. `#c/agent-a`.
 * @param agents - the rows the inbox answers with.
 * @returns the recorders a boot test asserts on.
 */
async function boot(hash: string, agents: readonly unknown[] = [row('agent-a')]) {
  window.location.hash = hash
  const sessions = sessionList()
  const opened: string[] = []
  const fetches: string[] = []
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('layout', { openPage: vi.fn() })
  ctx.provide('sessions', {
    list: sessions.store,
    refresh: async () => { sessions.add('s-agent-a') },
    open: (id: SessionId) => { opened.push(id) },
    openSubagent: () => {},
    refreshSubagents: async () => {},
    clear: () => {},
  })
  ctx.slots.register({
    name: 'root',
    children: {
      'sidebar.workspaces': { kind: 'single', scope: 'root' },
      'conversation.page': { kind: 'list', scope: 'root' },
    },
  } as never, (() => null) as never)
  vi.stubGlobal('fetch', vi.fn((input: string) => {
    fetches.push(input)
    let body: unknown = { person: { id: 'p-1', name: 'Person One' }, agents }
    if (input.endsWith('/channels')) body = { channels: [] }
    else if (input.includes('/channels/')) body = { messages: [] }
    else if (input.endsWith('/open')) {
      body = { agent: 'agent-a', sessionId: 's-agent-a', created: false, blank: true, lastActivityAt: null }
    }
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))
  }))
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  return { ctx, sessions, opened, fetches }
}

beforeEach(() => { localStorage.clear() })
afterEach(() => {
  vi.unstubAllGlobals()
  window.location.hash = ''
})

describe('the one reader of the URL fragment', () => {
  it('keeps #epsilons meaning the epsilon interface', () => {
    expect(EPSILONS_FRAGMENT).toBe('#epsilons')
    expect(surfaceOf('#epsilons')).toBe('epsilons')
    expect(surfaceOf('#epsilons/')).toBe('epsilons')
    expect(surfaceOf('epsilons')).toBe('epsilons')
    expect(bootIntentOf('#epsilons')).toEqual({ surface: 'epsilons', conversation: null })
  })

  it('reads a conversation address and keeps it on the inbox interface', () => {
    expect(CONVERSATION_FRAGMENT).toBe('#c/')
    expect(bootIntentOf('#c/delta')).toEqual({ surface: 'inbox', conversation: 'delta' })
    // A hand-written link may carry the leading slash question either way, and a
    // pasted one may keep a trailing slash.
    expect(bootIntentOf('#c/e3/')).toEqual({ surface: 'inbox', conversation: 'e3' })
    expect(bootIntentOf('c/delta')).toEqual({ surface: 'inbox', conversation: 'delta' })
    // The surface half of the same answer: a conversation is an inbox load.
    expect(surfaceOf('#c/delta')).toBe('inbox')
  })

  it('refuses to read anything else as a conversation', () => {
    for (const hash of ['', '#', '#c/', '#c', '#s/session-one', '#c/Bad', '#c/../x', '#c/delta/x',
      '#c/' + 'a'.repeat(65)]) {
      expect(bootIntentOf(hash), hash).toEqual({ surface: 'inbox', conversation: null })
    }
  })
})

describe('a page load addressed at one conversation', () => {
  it("opens that agent's conversation through the inbox door", async () => {
    const b = await boot('#c/agent-a')
    await vi.waitFor(() => { expect(b.opened).toEqual(['s-agent-a']) })
    // The one request per open is the door the sidebar row uses, naming the agent.
    expect(b.fetches.filter(input => input.endsWith('/open'))).toHaveLength(1)
    expect(b.sessions.store.getSnapshot().current).toBeUndefined()
  })

  it('does nothing when the person has no row for that agent', async () => {
    const b = await boot('#c/agent-a', [row('agent-b')])
    // Wait for the boot read to have resolved, so "nothing happened" is an
    // answer and not a race.
    await vi.waitFor(() => { expect(b.fetches.filter(input => input.endsWith('/agents') || input === '/v1/browser/inbox')).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.fetches.filter(input => input.endsWith('/open'))).toHaveLength(0)
    expect(b.opened).toEqual([])
  })

  it('does not open a recorded but disabled agent', async () => {
    const b = await boot('#c/agent-a', [row('agent-a', { enabled: false, disabled: true, presence: 'offline' })])
    await vi.waitFor(() => { expect(b.fetches.filter(input => input === '/v1/browser/inbox')).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.fetches.filter(input => input.endsWith('/open'))).toHaveLength(0)
    expect(b.opened).toEqual([])
  })

  it('leaves an unaddressed page load on the front page and opens nothing', async () => {
    const b = await boot('')
    await vi.waitFor(() => { expect(b.fetches.filter(input => input === '/v1/browser/inbox')).toHaveLength(1) })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.fetches.filter(input => input.endsWith('/open'))).toHaveLength(0)
  })

  it('still mounts the epsilon interface for #epsilons and opens nothing there', async () => {
    const b = await boot('#epsilons')
    await vi.waitFor(() => { expect(b.fetches.filter(input => input === '/v1/browser/inbox')).not.toHaveLength(0) })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(b.fetches.filter(input => input.endsWith('/open'))).toHaveLength(0)
    // The roster read is the epsilon interface's own ask, and it is made here:
    // that is what proves #epsilons still selected that interface.
    const entry = b.ctx.slots.entries('sidebar.workspaces')[0]
    const face = entry?.inject?.() as { hooks: { inbox: { getSnapshot: () => { workersState: string } } } }
    await vi.waitFor(() => { expect(['ready', 'loading']).toContain(face.hooks.inbox.getSnapshot().workersState) })
  })
})
