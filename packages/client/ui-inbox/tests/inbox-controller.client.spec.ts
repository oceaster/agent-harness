/**
 * The inbox controller: the state machine behind every screen and the one
 * place a row click becomes the open conversation.
 *
 * What these tests hold down, in the order the ticket states them:
 * - rows come from the API payload, in its order, and are never invented,
 *   merged or hidden;
 * - a row click issues exactly ONE open call for that agent, and nothing names
 *   a session id before that call answered;
 * - the conversation shown is the session id the server returned, selected
 *   through the sessions port once the client's list carries it;
 * - a refusal is rendered as a refusal: `cleared: false` or a failed call
 *   leaves the row populated, and a 403 on the list read is the profile
 *   refusal screen rather than a retryable error.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState, SessionSummary } from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InboxApi, InboxClearPayload, InboxListPayload, InboxOpenPayload, InboxOutcome,
} from '../src/client/inbox-api.ts'
import { InboxController, type InboxSessionPort } from '../src/client/inbox-controller.ts'

const sid = (id: string): SessionId => id as SessionId

const listPayload: InboxListPayload = {
  person: { id: 'p-1', name: 'Person One' },
  agents: [
    {
      agent: 'agent-a', name: 'Alpha', hasConversation: true,
      sessionId: 's-a', blank: false, lastActivityAt: 100, running: false,
    },
    {
      agent: 'agent-b', name: 'Beta', hasConversation: true,
      sessionId: 's-b', blank: true, lastActivityAt: null, running: true,
    },
    {
      agent: 'agent-c', name: 'Gamma', hasConversation: false,
      sessionId: null, blank: true, lastActivityAt: null, running: false,
    },
  ],
}

/** A session list that behaves like the runtime's snapshot source. */
function sessionList(ids: readonly string[] = []): {
  store: ReturnType<typeof createSnapshotStore<SessionListState>>
  add: (id: string, overrides?: Partial<SessionSummary>) => void
  remove: (id: string) => void
} {
  const summary = (id: string, overrides: Partial<SessionSummary> = {}): SessionSummary => ({
    id: sid(id), displayTitle: id, running: false, blank: true, updatedAt: 0, ...overrides,
  })
  const items = ids.map(id => summary(id))
  const store = createSnapshotStore<SessionListState>({
    ids: items.map(item => item.id),
    byId: Object.fromEntries(items.map(item => [item.id, item])),
    current: undefined,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  return {
    store,
    add: (id, overrides) => {
      const snapshot = store.getSnapshot()
      const row = summary(id, overrides)
      if (snapshot.ids.includes(sid(id))) {
        store.set({ ...snapshot, byId: { ...snapshot.byId, [sid(id)]: row } })
        return
      }
      store.set({
        ...snapshot,
        ids: [...snapshot.ids, sid(id)],
        byId: { ...snapshot.byId, [sid(id)]: row },
      })
    },
    remove: (id) => {
      const snapshot = store.getSnapshot()
      store.set({
        ...snapshot,
        ids: snapshot.ids.filter(candidate => candidate !== sid(id)),
        byId: Object.fromEntries(Object.entries(snapshot.byId).filter(([key]) => key !== id)),
      })
    },
  }
}

/** A manual clock so the "wait for the session list" path never sleeps. */
function clock(): {
  setTimer: (callback: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  flush: () => void
  pending: () => number
} {
  const timers = new Map<number, () => void>()
  let next = 0
  return {
    setTimer: (callback) => { next += 1; timers.set(next, callback); return next },
    clearTimer: (handle) => { timers.delete(handle as number) },
    flush: () => {
      const callbacks = [...timers.values()]
      timers.clear()
      for (const callback of callbacks) callback()
    },
    pending: () => timers.size,
  }
}

interface BenchOptions {
  list?: InboxOutcome<InboxListPayload>
  open?: InboxOutcome<InboxOpenPayload>
  clear?: InboxOutcome<InboxClearPayload>
  /** Runs after the open answer resolves — the fake's way of delivering `host/session-added`. */
  onOpen?: (agent: string) => void
  /** Runs when the controller pulls the host list (`sessions.refresh()`). */
  onRefresh?: () => void
  /** Make the pull itself fail (a restarting harness). */
  refreshFails?: boolean
  /** Omit the pull entirely, as a runtime without the verb would. */
  withoutRefresh?: boolean
  /** Make `openSubagent` refuse, as the runtime does for a stale address. */
  refuseWorker?: boolean
  sessions?: ReturnType<typeof sessionList>
}

/** Boot a controller over fake wire + session ports and record every call. */
function bench(options: BenchOptions = {}) {
  const calls: { api: string; agent?: string }[] = []
  let refreshes = 0
  const opened: string[] = []
  let cleared = false
  let list = options.list
  let open = options.open
  let clear = options.clear
  const sessions = options.sessions ?? sessionList()
  const api: InboxApi = {
    list: () => {
      calls.push({ api: 'list' })
      return Promise.resolve(list ?? { ok: true, value: listPayload })
    },
    open: (agent) => {
      calls.push({ api: 'open', agent })
      const answer = open ?? {
        ok: true as const,
        value: { agent, sessionId: 's-new', created: true, blank: true, lastActivityAt: null },
      }
      options.onOpen?.(agent)
      return Promise.resolve(answer)
    },
    clear: (agent) => {
      calls.push({ api: 'clear', agent })
      return Promise.resolve(clear ?? {
        ok: true as const,
        value: {
          agent, hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true,
        },
      })
    },
  }
  const hand = clock()
  const workers: { parentSessionId: string; childSessionId: string; mode: string }[] = []
  const port: InboxSessionPort = {
    list: sessions.store,
    // The runtime is the authority on openable children: this double records
    // the exact address the controller composed and moves the selection the way
    // `SessionManager.selectSubagent` does, so a highlight can be asserted.
    openSubagent: (address) => {
      workers.push({
        parentSessionId: address.parentSessionId,
        childSessionId: address.childSessionId,
        mode: address.mode,
      })
      if (options.refuseWorker === true) throw new Error('not a healthy catalog child')
      opened.push(address.childSessionId)
      sessions.store.set({ ...sessions.store.getSnapshot(), current: address.childSessionId })
    },
    // The real SessionRuntime projects every selection into `list.current` on
    // its own snapshot store, and the inbox derives the row highlight from that
    // value. A double that only recorded the call would let a click-only
    // highlight pass this suite while a reload showed no current row at all.
    open: (id) => {
      opened.push(id)
      sessions.store.set({ ...sessions.store.getSnapshot(), current: id })
    },
    clear: () => {
      cleared = true
      sessions.store.set({ ...sessions.store.getSnapshot(), current: undefined })
    },
    ...options.withoutRefresh === true ? {} : {
      refresh: () => {
        refreshes += 1
        if (options.refreshFails === true) return Promise.reject(new Error('harness restarting'))
        options.onRefresh?.()
        return Promise.resolve()
      },
    },
  }
  const controller = new InboxController({
    api,
    sessions: port,
    setTimer: hand.setTimer,
    clearTimer: hand.clearTimer,
  })
  return {
    controller,
    sessions,
    calls,
    opened,
    workerAddresses: workers,
    clearedFlag: () => cleared,
    refreshCount: () => refreshes,
    hand,
    state: () => controller.store.getSnapshot(),
    /** Swap the canned answer for the next call of that kind. */
    setList: (next: InboxOutcome<InboxListPayload>) => { list = next },
    setOpen: (next: InboxOutcome<InboxOpenPayload>) => { open = next },
    setClear: (next: InboxOutcome<InboxClearPayload>) => { clear = next },
  }
}

/** Let queued promise callbacks run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

describe('inbox controller: the list read', () => {
  it('renders the payload rows in the server order and nothing else', async () => {
    const b = bench()
    await b.controller.load()
    const state = b.state()
    expect(state.status).toBe('ready')
    expect(state.person).toEqual({ id: 'p-1', name: 'Person One' })
    expect(state.rows.map(row => row.agent)).toEqual(['agent-a', 'agent-b', 'agent-c'])
    expect(state.rows.map(row => row.name)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(state.loadError).toBeNull()
  })

  it('treats an empty agent list as a valid answer, not a failure', async () => {
    const b = bench({ list: { ok: true, value: { person: { id: 'p', name: 'P' }, agents: [] } } })
    await b.controller.load()
    expect(b.state().status).toBe('ready')
    expect(b.state().rows).toEqual([])
    expect(b.state().loadError).toBeNull()
  })

  it('makes a 403 on the list read the profile refusal, not a retryable error', async () => {
    const b = bench({ list: { ok: false, status: 403, code: 'forbidden' } })
    await b.controller.load()
    expect(b.state().status).toBe('refused')
    expect(b.state().rows).toEqual([])
    expect(b.state().loadError).toBeNull()
  })

  it('keeps a failed read visible with its code so the panel can retry', async () => {
    const b = bench({ list: { ok: false, status: 503, code: 'unavailable' } })
    await b.controller.load()
    expect(b.state().status).toBe('error')
    expect(b.state().loadError).toBe('unavailable')
  })

  it('keeps rows from an earlier read and says the refresh failed', async () => {
    const b = bench()
    await b.controller.load()
    b.setList({ ok: false, status: 0, code: 'transport' })
    await b.controller.load()
    expect(b.state().rows).toHaveLength(3)
    expect(b.state().loadError).toBe('transport')
    expect(b.state().status).toBe('error')
  })

  it('drops the in-flight read instead of stacking a second request', async () => {
    const b = bench()
    const first = b.controller.load()
    const second = b.controller.load()
    await Promise.all([first, second])
    expect(b.calls.filter(call => call.api === 'list')).toHaveLength(1)
  })
})

describe('inbox controller: opening a row', () => {
  it('issues exactly one open call and shows the session the server returned', async () => {
    const sessions = sessionList()
    const b = bench({
      sessions,
      onOpen: () => { sessions.add('s-new') },
    })
    await b.controller.load()
    await b.controller.open('agent-c')
    expect(b.calls.filter(call => call.api === 'open')).toEqual([{ api: 'open', agent: 'agent-c' }])
    expect(b.opened).toEqual(['s-new'])
    expect(b.state().openAgent).toBe('agent-c')
    const row = b.state().rows.find(candidate => candidate.agent === 'agent-c')
    expect(row?.hasConversation).toBe(true)
    expect(row?.sessionId).toBe('s-new')
    expect(row?.blank).toBe(true)
  })

  it('names no session before the open answer carries one', async () => {
    const sessions = sessionList()
    const seen: string[][] = []
    sessions.store.subscribe(() => { seen.push([...sessions.store.getSnapshot().ids]) })
    const b = bench({ sessions, onOpen: () => { sessions.add('s-new') } })
    await b.controller.load()
    await b.controller.open('agent-c')
    // The only id the list ever learned is the one the answer named.
    expect([...new Set(seen.flat())]).toEqual(['s-new'])
    expect(b.opened).toEqual(['s-new'])
  })

  it('pulls the host list once when the returned session is not in the mirror yet', async () => {
    const sessions = sessionList()
    const b = bench({ sessions, onRefresh: () => { sessions.add('s-new') } })
    await b.controller.load()
    await b.controller.open('agent-c')
    // One pull for the click, then the select becomes legal.
    expect(b.refreshCount()).toBe(1)
    expect(b.opened).toEqual(['s-new'])
    expect(b.state().notices).toEqual({})
  })

  it('does not pull the host list when the mirror already carries the session', async () => {
    const sessions = sessionList(['s-new'])
    const b = bench({ sessions })
    await b.controller.load()
    await b.controller.open('agent-c')
    expect(b.refreshCount()).toBe(0)
    expect(b.opened).toEqual(['s-new'])
  })

  it('reports a failed pull as an open failure, never as a selection', async () => {
    const b = bench({ refreshFails: true })
    await b.controller.load()
    await b.controller.open('agent-c')
    expect(b.opened).toEqual([])
    expect(b.state().notices['agent-c']).toBe('session-not-listed')
    expect(b.state().busy).toEqual([])
  })

  it('waits for the session-added frame instead of polling the list', async () => {
    const sessions = sessionList()
    const b = bench({ sessions })
    await b.controller.load()
    const pending = b.controller.open('agent-c')
    await settle()
    // The answer landed, the list has not been told yet: no selection, no failure.
    expect(b.opened).toEqual([])
    expect(b.state().busy).toEqual(['agent-c'])
    expect(b.hand.pending()).toBe(1)
    sessions.add('s-new')
    await settle()
    await pending
    expect(b.opened).toEqual(['s-new'])
    expect(b.state().busy).toEqual([])
    expect(b.state().notices).toEqual({})
  })

  it('reports a session that never reaches the client list', async () => {
    // No pull verb at all, and no frame: the row must say so rather than throw.
    const b = bench({ withoutRefresh: true })
    await b.controller.load()
    const pending = b.controller.open('agent-c')
    await settle()
    b.hand.flush()
    await pending
    expect(b.opened).toEqual([])
    expect(b.state().notices['agent-c']).toBe('session-not-listed')
    expect(b.state().busy).toEqual([])
  })

  it('renders a 409 as a real error on the row', async () => {
    const b = bench({ open: { ok: false, status: 409, code: 'conflict' } })
    await b.controller.load()
    await b.controller.open('agent-a')
    expect(b.state().notices['agent-a']).toBe('conflict')
    expect(b.opened).toEqual([])
    const row = b.state().rows.find(candidate => candidate.agent === 'agent-a')
    // The row keeps the conversation the server still reports.
    expect(row?.hasConversation).toBe(true)
    expect(row?.sessionId).toBe('s-a')
  })

  it('renders a 502 as an open failure, never as an opened conversation', async () => {
    const sessions = sessionList(['s-seeded'])
    const b = bench({ sessions, open: { ok: false, status: 502, code: 'hostUnavailable' } })
    await b.controller.load()
    await b.controller.open('agent-c')
    expect(b.state().notices['agent-c']).toBe('hostUnavailable')
    expect(b.state().openAgent).toBeNull()
    expect(b.opened).toEqual([])
    expect(b.state().rows.find(row => row.agent === 'agent-c')?.hasConversation).toBe(false)
  })

  it('ignores a second click while the first open call is in flight', async () => {
    const sessions = sessionList()
    const b = bench({ sessions, onOpen: () => { sessions.add('s-new') } })
    await b.controller.load()
    await Promise.all([b.controller.open('agent-c'), b.controller.open('agent-c')])
    expect(b.calls.filter(call => call.api === 'open')).toHaveLength(1)
  })

  it('clears a row notice when the next attempt starts', async () => {
    const sessions = sessionList()
    const b = bench({ sessions, open: { ok: false, status: 403, code: 'forbidden' } })
    await b.controller.load()
    await b.controller.open('agent-a')
    expect(b.state().notices['agent-a']).toBe('forbidden')
    const retry = b.controller.open('agent-a')
    // The previous failure stops describing the row the moment a new attempt
    // starts (before its answer lands).
    expect(b.state().notices).toEqual({})
    await retry
    // This answer failed too, so the notice comes back with it.
    expect(b.state().notices['agent-a']).toBe('forbidden')
  })

  it('forgets a notice for a row the server no longer returns', async () => {
    const b = bench({ open: { ok: false, status: 403, code: 'forbidden' } })
    await b.controller.load()
    await b.controller.open('agent-a')
    b.setList({
      ok: true,
      value: { person: { id: 'p-1', name: 'Person One' }, agents: [listPayload.agents[2]!] },
    })
    await b.controller.load()
    expect(b.state().notices).toEqual({})
    expect(b.state().rows.map(row => row.agent)).toEqual(['agent-c'])
  })
})

describe('inbox controller: running subagents keep the parent row working', () => {
  /** Add one session below `parent`, the way the host lists a spawned agent. */
  const spawn = (
    sessions: ReturnType<typeof sessionList>, id: string, parent: string, running: boolean,
  ): void => { sessions.add(id, { parentId: sid(parent), origin: 'subagent', running }) }

  it('counts running descendants of the row own session at any depth', async () => {
    const sessions = sessionList(['s-a'])
    const b = bench({ sessions })
    await b.controller.load()
    b.controller.followSessions()
    spawn(sessions, 'sub-1', 's-a', true)     // child
    spawn(sessions, 'sub-1b', 's-a', true)    // its sibling, also running
    spawn(sessions, 'sub-2', 'sub-1', true)   // grandchild
    spawn(sessions, 'sub-3', 'sub-2', false)  // great-grandchild, finished
    await settle()
    expect(b.state().activeSubagents).toEqual({ 'agent-a': 3 })
  })

  it('never counts a session belonging to another row', async () => {
    const sessions = sessionList(['s-a', 's-b'])
    const b = bench({ sessions })
    await b.controller.load()
    b.controller.followSessions()
    spawn(sessions, 'sub-b', 's-b', true)
    await settle()
    // Only agent-b's row carries a count; agent-a owns no part of that lineage.
    expect(b.state().activeSubagents).toEqual({ 'agent-b': 1 })
  })

  it('follows the session store: a subagent starting and finishing updates the count', async () => {
    const sessions = sessionList(['s-a'])
    const b = bench({ sessions })
    await b.controller.load()
    b.controller.followSessions()
    const requestsBefore = b.calls.length
    spawn(sessions, 'sub-1', 's-a', true)
    await settle()
    expect(b.state().activeSubagents['agent-a']).toBe(1)
    spawn(sessions, 'sub-1', 's-a', false)
    await settle()
    expect(b.state().activeSubagents).toEqual({})
    // A frame is not a request: the count costs nothing on the wire.
    expect(b.calls).toHaveLength(requestsBefore)
  })

  it('stores no count for zero descendants, and none for a row with no conversation', async () => {
    const sessions = sessionList(['s-a'])
    const b = bench({ sessions })
    await b.controller.load()
    b.controller.followSessions()
    // A finished subagent is still listed; it is simply not running.
    spawn(sessions, 'sub-1', 's-a', false)
    await settle()
    expect(b.state().activeSubagents).toEqual({})
    expect(b.state().activeSubagents['agent-c']).toBeUndefined()
  })

  it('drops the count when the row conversation is cleared', async () => {
    const sessions = sessionList(['s-a'])
    const b = bench({ sessions })
    await b.controller.load()
    b.controller.followSessions()
    spawn(sessions, 'sub-1', 's-a', true)
    await settle()
    expect(b.state().activeSubagents).toEqual({ 'agent-a': 1 })
    // Clearing removes the row's session; the count must not outlive it.
    await b.controller.clear('agent-a')
    expect(b.state().activeSubagents).toEqual({})
  })

  it('keeps the server queue count on the row while frames move the running count', async () => {
    const queued: InboxListPayload = {
      person: { id: 'p-1', name: 'Person One' },
      agents: [{ ...listPayload.agents[0]!, queuedWorkers: 1 }],
    }
    const sessions = sessionList(['s-a'])
    const b = bench({ sessions, list: { ok: true, value: queued } })
    await b.controller.load()
    b.controller.followSessions()
    // The queued count is the payload's, and a live frame never edits it.
    expect(b.state().rows[0]?.queuedWorkers).toBe(1)
    spawn(sessions, 'sub-1', 's-a', true)
    await settle()
    const row = b.state().rows[0]
    expect(row?.queuedWorkers).toBe(1)
    expect(b.state().activeSubagents).toEqual({ 'agent-a': 1 })
  })

  it('walks a corrupt lineage once instead of hanging on a cycle', async () => {
    const sessions = sessionList(['s-a'])
    // A lineage the walk must survive: one of the row's sessions claims the row as its child.
    sessions.add('s-a', { parentId: sid('sub-1') })
    spawn(sessions, 'sub-1', 's-a', true)
    const b = bench({ sessions })
    await b.controller.load()
    b.controller.followSessions()
    await settle()
    expect(b.state().activeSubagents).toEqual({ 'agent-a': 1 })
  })
})

describe('inbox controller: clearing a row', () => {
  it('returns the row to the fresh state and resets the pane', async () => {
    const sessions = sessionList(['s-a'])
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-a') })
    const b = bench({ sessions })
    await b.controller.load()
    await b.controller.clear('agent-a')
    expect(b.calls.filter(call => call.api === 'clear')).toEqual([{ api: 'clear', agent: 'agent-a' }])
    const row = b.state().rows.find(candidate => candidate.agent === 'agent-a')
    expect(row).toEqual({
      agent: 'agent-a', name: 'Alpha', hasConversation: false,
      sessionId: null, blank: true, lastActivityAt: null, running: false,
    })
    expect(b.clearedFlag()).toBe(true)
  })

  it('never renders a refused clear as cleared', async () => {
    const b = bench({
      clear: {
        ok: true,
        value: {
          agent: 'agent-a', hasConversation: true, sessionId: 's-a', blank: false, lastActivityAt: 100, cleared: false,
        },
      },
    })
    await b.controller.load()
    await b.controller.clear('agent-a')
    const row = b.state().rows.find(candidate => candidate.agent === 'agent-a')
    expect(row?.hasConversation).toBe(true)
    expect(row?.sessionId).toBe('s-a')
    expect(row?.lastActivityAt).toBe(100)
    expect(b.state().notices['agent-a']).toBe('clear-refused')
    expect(b.clearedFlag()).toBe(false)
  })

  it('keeps the row populated when the clear call fails', async () => {
    const b = bench({ clear: { ok: false, status: 503, code: 'unavailable' } })
    await b.controller.load()
    await b.controller.clear('agent-b')
    const row = b.state().rows.find(candidate => candidate.agent === 'agent-b')
    expect(row?.hasConversation).toBe(true)
    expect(row?.sessionId).toBe('s-b')
    expect(b.state().notices['agent-b']).toBe('unavailable')
  })

  it('leaves the pane alone when the cleared conversation was not the open one', async () => {
    const sessions = sessionList(['s-a', 's-b'])
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-b') })
    const b = bench({ sessions })
    await b.controller.load()
    await b.controller.clear('agent-a')
    expect(b.clearedFlag()).toBe(false)
  })

  it('clears the open row marker when the open conversation is cleared', async () => {
    const sessions = sessionList()
    const b = bench({ sessions, onOpen: () => { sessions.add('s-new') } })
    await b.controller.load()
    await b.controller.open('agent-c')
    expect(b.state().openAgent).toBe('agent-c')
    await b.controller.clear('agent-c')
    expect(b.state().openAgent).toBeNull()
    expect(b.clearedFlag()).toBe(true)
  })

  it('treats clearing an empty row as a no-op success', async () => {
    const b = bench({
      clear: {
        ok: true,
        value: {
          agent: 'agent-c', hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true,
        },
      },
    })
    await b.controller.load()
    await b.controller.clear('agent-c')
    expect(b.state().notices).toEqual({})
    expect(b.state().rows.find(row => row.agent === 'agent-c')?.hasConversation).toBe(false)
  })
})

describe('inbox controller: the current row follows the runtime selection', () => {
  it('marks the row of the session the runtime restored, with no click behind it', async () => {
    // The reload case: the runtime restores `dsh.sessions.current` before any
    // click exists, so a click-only marker would leave the pane painting a
    // conversation with no current row.
    const sessions = sessionList(['s-a'])
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-a') })
    const b = bench({ sessions })
    b.controller.followSessions()
    await b.controller.load()
    expect(b.state().openAgent).toBe('agent-a')
    expect(b.calls.filter(call => call.api === 'open')).toEqual([])
    expect(b.opened).toEqual([])
  })

  it('follows the selection frame by frame, in either arrival order', async () => {
    // Rows first, then the frame.
    const sessions = sessionList(['s-a', 's-b'])
    const b = bench({ sessions })
    const stop = b.controller.followSessions()
    await b.controller.load()
    expect(b.state().openAgent).toBeNull()
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-b') })
    await settle()
    expect(b.state().openAgent).toBe('agent-b')
    // A row the server no longer names a conversation for is still matched by
    // the id the runtime holds: agent-c has no session, so no row is marked.
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-unknown') })
    await settle()
    expect(b.state().openAgent).toBeNull()
    stop()
  })

  it('clears the marker when the runtime clears its selection', async () => {
    const sessions = sessionList(['s-a'])
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-a') })
    const b = bench({ sessions })
    b.controller.followSessions()
    await b.controller.load()
    expect(b.state().openAgent).toBe('agent-a')
    sessions.store.set({ ...sessions.store.getSnapshot(), current: undefined })
    await settle()
    expect(b.state().openAgent).toBeNull()
  })

  it('a restored conversation that no longer exists leaves the ordinary default, silently', async () => {
    // The runtime keeps a persisted selection whose session the host does not
    // list (a deleted conversation, or an agent removed from the roster): no row
    // names it, so no row claims to be open and nothing is reported as failed.
    const sessions = sessionList(['s-a'])
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-deleted') })
    const b = bench({ sessions })
    b.controller.followSessions()
    await b.controller.load()
    expect(b.state().openAgent).toBeNull()
    expect(b.state().notices).toEqual({})
    expect(b.state().busy).toEqual([])
    expect(b.state().status).toBe('ready')
    // A conversation that does exist still marks its row afterwards.
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-a') })
    await settle()
    expect(b.state().openAgent).toBe('agent-a')
  })

  it('never marks a row for a subagent conversation', async () => {
    const sessions = sessionList(['s-a'])
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-a') })
    const b = bench({ sessions })
    b.controller.followSessions()
    await b.controller.load()
    sessions.add('s-sub', { parentId: sid('s-a'), origin: 'subagent', running: true })
    sessions.store.set({
      ...sessions.store.getSnapshot(),
      current: sid('s-sub'),
      byId: { ...sessions.store.getSnapshot().byId, [sid('s-sub')]: {
        id: sid('s-sub'), displayTitle: 's-sub', running: true, blank: false, updatedAt: 0,
        parentId: sid('s-a'), origin: 'subagent',
      } },
    })
    await settle()
    expect(b.state().openAgent).toBeNull()
  })
})

describe('inbox controller: live badges without polling', () => {
  it('folds running and blank from the session list into the matching row', async () => {
    const sessions = sessionList(['s-a'])
    const b = bench({ sessions })
    await b.controller.load()
    const stop = b.controller.followSessions()
    const requestsBefore = b.calls.length
    sessions.add('s-a', { running: true, blank: false })
    await settle()
    const row = b.state().rows.find(candidate => candidate.agent === 'agent-a')
    expect(row?.running).toBe(true)
    expect(row?.blank).toBe(false)
    // A frame is not a request: the badge costs nothing on the wire.
    expect(b.calls).toHaveLength(requestsBefore)
    stop()
    sessions.add('s-a', { running: false })
    await settle()
    expect(b.state().rows.find(candidate => candidate.agent === 'agent-a')?.running).toBe(true)
  })
})

describe('inbox controller: Delta\'s sub-agent roster', () => {
  /** One catalog entry, shaped exactly as the harness's `subagent.list` answers. */
  type CatalogEntry = SessionListState['subagentsByParent'][SessionId]['entries'][number]
  const child = (
    id: string,
    overrides: Partial<Extract<CatalogEntry, { kind: 'child' }>> = {},
  ): CatalogEntry => ({
    kind: 'child', id: sid(id), mode: 'continuable', label: `task ${id}`,
    activity: 'inactive', hasChildren: false, ...overrides,
  })

  /** Put one parent's catalog on the session list, as the runtime projects it. */
  const catalog = (
    sessions: ReturnType<typeof sessionList>,
    parentId: string,
    entries: readonly CatalogEntry[],
  ): void => {
    const snapshot = sessions.store.getSnapshot()
    sessions.store.set({
      ...snapshot,
      subagentsByParent: {
        ...snapshot.subagentsByParent,
        [sid(parentId)]: { entries, parentAvailable: true, state: 'ready', error: null },
      },
    })
  }

  /** Delta's own row is what names the parent session the roster is read from. */
  const deltaList: InboxListPayload = {
    person: { id: 'p-1', name: 'Person One' },
    agents: [
      {
        agent: 'delta', name: 'Delta', hasConversation: true,
        sessionId: 's-delta', blank: false, lastActivityAt: 100, running: false,
      },
      {
        agent: 'agent-a', name: 'Alpha', hasConversation: true,
        sessionId: 's-agent-a', blank: false, lastActivityAt: 100, running: false,
      },
    ],
  }

  /** A household whose Delta conversation is `s-delta`. */
  const withDelta = () => sessionList(['s-delta'])

  it('is empty until Delta\'s catalog lands, and never reads another parent\'s', async () => {
    const sessions = withDelta()
    const b = bench({ sessions, list: { ok: true, value: deltaList } })
    await b.controller.load()
    b.controller.followSessions()
    expect(b.state().workers).toEqual([])
    await b.controller.loadWorkers()
    expect(b.state().workers).toEqual([])
    catalog(sessions, 's-delta', [child('w-1'), child('w-2', { mode: 'one-shot', activity: 'running' })])
    await b.controller.loadWorkers()
    expect(b.state().workers.map(row => row.id)).toEqual([sid('w-1'), sid('w-2')])
    expect(b.state().workers.map(row => row.index)).toEqual([1, 2])
    expect(b.state().workers.map(row => row.mode)).toEqual(['continuable', 'one-shot'])
    expect(b.state().workers.map(row => row.running)).toEqual([false, true])
    expect(b.state().workers.map(row => row.label)).toEqual(['task w-1', 'task w-2'])
  })

  it('lists Delta\'s workers whichever conversation is open', async () => {
    const sessions = withDelta()
    const b = bench({ sessions, list: { ok: true, value: deltaList } })
    await b.controller.load()
    b.controller.followSessions()
    catalog(sessions, 's-delta', [child('w-delta')])
    catalog(sessions, 's-agent-a', [child('w-other')])
    await b.controller.loadWorkers()
    // With agent-a's conversation on screen the roster is still Delta's: this is
    // the whole correction - a list of Delta's sub-agents, not of the pane.
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-agent-a') })
    b.controller.followSessions()
    await settle()
    expect(b.state().workers.map(row => row.id)).toEqual([sid('w-delta')])
    sessions.store.set({ ...sessions.store.getSnapshot(), current: sid('s-delta') })
    await settle()
    expect(b.state().workers.map(row => row.id)).toEqual([sid('w-delta')])
  })

  it('has no roster to read when the person has no Delta conversation', async () => {
    const sessions = sessionList(['s-agent-a'])
    const b = bench({ sessions, list: { ok: true, value: deltaList } })
    await b.controller.load()
    await b.controller.loadWorkers()
    expect(b.state().workers).toEqual([])
    // An absent Delta conversation is an answer, not a failure: the panel says
    // Delta has no sub-agents rather than showing a broken roster.
    expect(b.state().workersState).toBe('ready')
  })

  it('opens a worker through its exact catalog address and highlights its row', async () => {
    const sessions = withDelta()
    const b = bench({ sessions, list: { ok: true, value: deltaList } })
    await b.controller.load()
    catalog(sessions, 's-delta', [child('w-1'), child('w-2', { mode: 'one-shot' })])
    await b.controller.loadWorkers()
    const requestsBefore = b.calls.length
    b.controller.openWorker('w-2')
    // No request of any kind: the address the row carries is the whole call.
    expect(b.workerAddresses).toEqual([
      { parentSessionId: sid('s-delta'), childSessionId: sid('w-2'), mode: 'one-shot' },
    ])
    expect(b.calls).toHaveLength(requestsBefore)
    await settle()
    expect(b.state().openWorkerId).toBe(sid('w-2'))
  })

  it('reports a refused address on the row instead of pretending it opened', async () => {
    const sessions = withDelta()
    const b = bench({ sessions, refuseWorker: true, list: { ok: true, value: deltaList } })
    await b.controller.load()
    catalog(sessions, 's-delta', [child('w-1')])
    await b.controller.loadWorkers()
    b.controller.openWorker('w-1')
    expect(b.state().workerNotice).toEqual({ id: sid('w-1'), code: 'worker-unavailable' })
  })

  it('renders an unidentifiable child as a statement, not a door', async () => {
    const sessions = withDelta()
    const b = bench({ sessions, list: { ok: true, value: deltaList } })
    await b.controller.load()
    catalog(sessions, 's-delta', [
      { kind: 'diagnostic', id: sid('w-bad'), reason: 'descriptor-missing' } as unknown as CatalogEntry,
    ])
    await b.controller.loadWorkers()
    expect(b.state().workers.map(row => ({ id: row.id, damaged: row.damaged })))
      .toEqual([{ id: sid('w-bad'), damaged: true }])
  })
})
