// @vitest-environment jsdom
/**
 * InboxPanel: what the person sees and the two gestures that reach the wire.
 *
 * The suite feeds props directly (a driven store instance plus the injected
 * callbacks) and asserts user-visible behavior: one row per payload agent in
 * the payload's order, the three state lines, the menu holding exactly one
 * action, the confirmation naming the agent and the permanence of the delete,
 * Escape/outside-click cancellation, the focus trap, and the distinct screens
 * for loading, empty, refused and failed reads.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { InboxAgentRow } from '../src/client/inbox-api.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { InboxPanel } from '../src/client/InboxPanel.tsx'
import type { InboxState } from '../src/client/inbox-controller.ts'
import type { ChannelState } from '../src/client/channel-controller.ts'
import { en } from '../src/client/locales.ts'
import type { InboxPanelProps } from '../src/client/slots.ts'

afterEach(cleanup)
// The panel reads one clock per render; pin it so relative times are stable.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-06-01T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const t: InboxPanelProps['t'] = makeTranslate(en, commonZh)

const NOW_SECONDS = new Date('2026-06-01T12:00:00Z').getTime() / 1000

const row = (overrides: Partial<InboxAgentRow> & Pick<InboxAgentRow, 'agent' | 'name'>): InboxAgentRow => ({
  hasConversation: true,
  sessionId: `s-${overrides.agent}`,
  blank: false,
  lastActivityAt: NOW_SECONDS - 300,
  running: false,
  ...overrides,
})

const ROWS: InboxAgentRow[] = [
  row({ agent: 'agent-a', name: 'Alpha' }),
  row({ agent: 'agent-b', name: 'Beta', blank: true, lastActivityAt: null }),
  row({ agent: 'agent-c', name: 'Gamma', hasConversation: false, sessionId: null, blank: true, lastActivityAt: null }),
]

/** A driven store instance the test writes through. */
function store(initial: Partial<InboxState> = {}): SnapshotStore<InboxState> {
  return createSnapshotStore<InboxState>({
    status: 'ready',
    person: { id: 'p-1', name: 'Person One' },
    rows: ROWS,
    loadError: null,
    busy: [],
    notices: {},
    openAgent: null,
    activeSubagents: {},
    workers: [],
    workersState: 'idle',
    openWorkerId: null,
    workerNotice: null,
    ...initial,
  })
}

function mount(overrides: {
  state?: Partial<InboxState>
  wide?: boolean
  portrait?: boolean
} = {}) {
  const inbox = store(overrides.state)
  const open = vi.fn()
  const openWorker = vi.fn()
  const clear = vi.fn()
  const load = vi.fn()
  const expandSidebar = vi.fn()
  const collapseSidebar = vi.fn()
  const collapseOnSelection = vi.fn()
  const channels = createSnapshotStore<ChannelState>({ rows:[{ id:'delta-darwin',name:'Delta-Darwin',agents:['delta','darwin'] }],selected:null,messages:[],error:null,loading:false })
  const openChannel = vi.fn()
  const clearChannel = vi.fn()
  // The runtime share also carries the global session/workspace hooks; the
  // panel never reads them, so they are never-called stubs.
  const neverHook = (() => { throw new Error('the inbox panel must not read global hooks') }) as never
  const props: InboxPanelProps = {
    wide: overrides.wide ?? true,
    portrait: overrides.portrait ?? false,
    expandSidebar,
    collapseSidebar,
    collapseOnSelection,
    useChannels: bindSnapshotSelector(channels),
    openChannel,
    clearChannel,
    useSessions: neverHook,
    useWorkspaces: neverHook,
    useInbox: bindSnapshotSelector(inbox),
    load,
    open,
    openWorker,
    loadWorkers: vi.fn(),
    clear,
    t,
  }
  const view = render(<InboxPanel {...props} />)
  return {
    ...view, inbox, channels, open, openWorker, clear, load, expandSidebar, collapseSidebar, collapseOnSelection,
    openChannel, clearChannel,
  }
}

describe('inbox panel: rows', () => {
  it('shows the five statuses and blocks disabled agents', () => {
    const rows = [
      row({ agent: 'delta', name: 'Delta', enabled: true, presence: 'online' }),
      row({ agent: 'darwin', name: 'Darwin', enabled: true, running: true }),
      row({ agent: 'diana', name: 'Diana', enabled: true, presence: 'unread' }),
      row({ agent: 'dexter', name: 'Dexter', enabled: false, disabled: true, presence: 'offline' }),
      row({ agent: 'failed', name: 'Failed', enabled: true, presence: 'error' }),
    ]
    const b = mount({ state: { rows } })
    for (const [agent, status] of [['delta','online'],['darwin','running'],['diana','unread'],['dexter','offline'],['failed','error']] as const) {
      expect(screen.getByTestId('ui-inbox-open-' + agent).querySelector('[data-presence="' + status + '"]')).not.toBeNull()
    }
    const dexter = screen.getByTestId('ui-inbox-open-dexter') as HTMLButtonElement
    expect(dexter.disabled).toBe(true)
    expect(dexter.textContent).toContain('Disabled')
    fireEvent.click(dexter)
    expect(b.open).not.toHaveBeenCalled()
    expect(screen.getByTestId('agent-channel-open-delta-darwin').querySelector('[data-presence="online"]')).not.toBeNull()
    act(() => { b.inbox.set({ ...b.inbox.getSnapshot(), rows: rows.map(item => item.agent === 'darwin' ? { ...item, enabled: false } : item) }) })
    expect(screen.getByTestId('agent-channel-open-delta-darwin').querySelector('[data-presence="offline"]')).not.toBeNull()
  })

  it('opens channels from full sidebar rows and clears through their dropdown confirmation', async () => {
    const b = mount()
    expect(screen.getByTestId('agent-channel-row-delta-darwin').tagName).toBe('LI')
    fireEvent.click(screen.getByTestId('agent-channel-open-delta-darwin'))
    expect(b.openChannel).toHaveBeenCalledWith('delta-darwin')
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(screen.getByTestId('agent-channel-menu-delta-darwin'))
    fireEvent.click((await screen.findAllByRole('menuitem'))[0]!)
    expect(screen.getByRole('dialog').textContent).toContain('Clear your channel Delta-Darwin?')
    expect(b.clearChannel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId('ui-inbox-confirm-clear'))
    expect(b.clearChannel).toHaveBeenCalledWith('delta-darwin')
  })

  it('renders one row per payload agent, in the payload order', () => {
    mount()
    const rows = screen.getAllByTestId(/^ui-inbox-row-/)
    expect(rows).toHaveLength(3)
    expect(rows.map(node => node.getAttribute('data-testid')))
      .toEqual(['ui-inbox-row-agent-a', 'ui-inbox-row-agent-b', 'ui-inbox-row-agent-c'])
    expect(screen.getByText('Alpha')).toBeDefined()
    expect(screen.getByText('Beta')).toBeDefined()
    expect(screen.getByText('Gamma')).toBeDefined()
  })

  it('shows the three state lines: last activity, no messages yet, no conversation yet', () => {
    mount()
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toContain('5m ago')
    expect(screen.getByTestId('ui-inbox-state-agent-b').textContent).toBe('No messages yet')
    expect(screen.getByTestId('ui-inbox-state-agent-c').textContent).toBe('No conversation yet')
  })

  it('shows the working copy while the agent\'s own turn runs, with no count suffix', () => {
    mount({ state: { rows: [row({ agent: 'agent-a', name: 'Alpha', running: true })] } })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working...')
    const dot = screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Working')
    expect(dot?.getAttribute('title')).toBe('Working')
  })

  // The verb each agent says, in product copy: the state line in full and the
  // dot's bare label. Only the verb changes with the agent.
  const AGENT_VERBS: ReadonlyArray<readonly [string, string, string]> = [
    ['delta', 'Working...', 'Working'],
    ['darwin', 'Working...', 'Working'],
    ['diana', 'Chatting...', 'Chatting'],
    ['dexter', 'Thinking...', 'Thinking'],
    // An id the map does not know (a preset this deployment composes): the
    // generic verb, never an empty row.
    ['agent-unknown', 'Working...', 'Working'],
  ]
  for (const [agent, line, bare] of AGENT_VERBS) {
    it(`says the agent's own verb for ${agent}: ${line}`, () => {
      mount({ state: { rows: [row({ agent, name: agent, running: true })] } })
      expect(screen.getByTestId(`ui-inbox-state-${agent}`).textContent).toBe(line)
      const dot = screen.getByTestId(`ui-inbox-open-${agent}`).querySelector('[data-presence="running"]')
      expect(dot?.getAttribute('aria-label')).toBe(bare)
      expect(dot?.getAttribute('title')).toBe(bare)
    })
  }

  // Every count rule the row has, now on the agent's own verb. The number is the
  // total in flight — running plus queued — never a working/total pair.
  const COUNT_CASES: ReadonlyArray<readonly [string, number, number, string]> = [
    ['delta', 2, 0, 'Working... (2)'],
    ['delta', 3, 1, 'Working... (4)'],
    ['diana', 2, 0, 'Chatting... (2)'],
    ['dexter', 1, 1, 'Thinking... (2)'],
    ['agent-unknown', 3, 0, 'Working... (3)'],
  ]
  for (const [agent, active, queued, line] of COUNT_CASES) {
    it(`keeps the count on the agent's own verb: ${line}`, () => {
      mount({
        state: {
          rows: [row({ agent, name: agent, ...(queued > 0 ? { queuedWorkers: queued } : {}) })],
          activeSubagents: { [agent]: active },
        },
      })
      expect(screen.getByTestId(`ui-inbox-state-${agent}`).textContent).toBe(line)
      // The dot label IS the state line once a count is shown.
      const dot = screen.getByTestId(`ui-inbox-open-${agent}`).querySelector('[data-presence="running"]')
      expect(dot?.getAttribute('aria-label')).toBe(line)
    })
  }

  it('says the agent\'s own verb on the rail dot too', () => {
    mount({ wide: false, state: { rows: [row({ agent: 'diana', name: 'Diana', running: true })] } })
    const dot = screen.getByTestId('ui-inbox-rail-diana').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Chatting')
  })

  it('reports an idle parent row as working while one subagent runs, with the count inline', () => {
    mount({ state: { rows: [row({ agent: 'agent-a', name: 'Alpha', running: false })], activeSubagents: { 'agent-a': 1 } } })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (1)')
    const dot = screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="running"]')
    // The dot says the same thing as the state line, not plain 'Running'.
    expect(dot?.getAttribute('aria-label')).toBe('Working... (1)')
    expect(dot?.getAttribute('title')).toBe('Working... (1)')
    // The whole-row accessible name is still the row's own, not the dot's.
    expect(screen.getByTestId('ui-inbox-open-agent-a').getAttribute('aria-label'))
      .toBe('Open your conversation with Alpha')
  })

  it('renders several running subagents as their exact count', () => {
    mount({ state: { rows: [row({ agent: 'agent-a', name: 'Alpha' })], activeSubagents: { 'agent-a': 4 } } })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (4)')
  })

  it('shows the single total for several running subagents with a queue behind them', () => {
    // The case that used to render a working/total pair (`Working... (3/4)`):
    // three running plus one still queued is four in flight, so the line says
    // four and nothing else — no slash, no second number.
    mount({ state: { rows: [row({ agent: 'agent-a', name: 'Alpha', queuedWorkers: 1 })], activeSubagents: { 'agent-a': 3 } } })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (4)')
    const dot = screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Working... (4)')
    expect(dot?.getAttribute('title')).toBe('Working... (4)')
    // The row's own accessible name is untouched by the count.
    expect(screen.getByTestId('ui-inbox-open-agent-a').getAttribute('aria-label'))
      .toBe('Open your conversation with Alpha')
  })

  it("renders the owner's own shape: three running plus six queued is Working... (9)", () => {
    mount({ state: { rows: [row({ agent: 'delta', name: 'Delta', queuedWorkers: 6 })], activeSubagents: { delta: 3 } } })
    expect(screen.getByTestId('ui-inbox-state-delta').textContent).toBe('Working... (9)')
  })

  it('counts queued work with nothing running, and still reports working', () => {
    // Work is outstanding, so the row must not fall back to the idle line even
    // though no subagent is running yet.
    mount({
      state: {
        rows: [row({ agent: 'agent-a', name: 'Alpha', running: false, queuedWorkers: 2 })],
        activeSubagents: {},
      },
    })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (2)')
    const dot = screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Working... (2)')
    expect(dot?.getAttribute('title')).toBe('Working... (2)')
  })

  it('keeps the bare verb when nothing is in flight, and never renders a (0)', () => {
    mount({
      state: {
        rows: [
          // Running, with no subagent below it and an explicitly empty queue.
          row({ agent: 'agent-a', name: 'Alpha', running: true, queuedWorkers: 0 }),
          // Nothing running and nothing queued at all.
          row({ agent: 'agent-b', name: 'Beta', running: false }),
        ],
        activeSubagents: {},
      },
    })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working...')
    expect(screen.getByTestId('ui-inbox-state-agent-b').textContent).toBe('5m ago')
    for (const agent of ['agent-a', 'agent-b']) {
      expect(screen.getByTestId(`ui-inbox-state-${agent}`).textContent).not.toContain('(0)')
    }
    const dot = screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Working')
    expect(dot?.getAttribute('title')).toBe('Working')
  })

  it('keeps the same count when nothing is queued, whether the field says 0 or is absent', () => {
    const rows = [
      row({ agent: 'agent-a', name: 'Alpha', queuedWorkers: 0 }),
      // No field at all: an older server, or an agent that never delegates.
      row({ agent: 'agent-b', name: 'Beta' }),
    ]
    mount({ state: { rows, activeSubagents: { 'agent-a': 3, 'agent-b': 3 } } })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (3)')
    expect(screen.getByTestId('ui-inbox-state-agent-b').textContent).toBe('Working... (3)')
  })

  it('follows the queue as it drains, on the store the row already reads', () => {
    const b = mount({
      state: { rows: [row({ agent: 'agent-a', name: 'Alpha', queuedWorkers: 1 })], activeSubagents: { 'agent-a': 3 } },
    })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (4)')
    // The live frame that starts the waiting worker raises the running count at
    // once; the queued figure is the server's, so it only moves on the next
    // inbox read the row already performs (no new polling). One refresh of
    // staleness is visible, then the queue drains: four running, none waiting.
    act(() => {
      b.inbox.set({ ...b.inbox.getSnapshot(), activeSubagents: { 'agent-a': 4 } })
    })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (5)')
    act(() => {
      b.inbox.set({
        ...b.inbox.getSnapshot(),
        rows: [row({ agent: 'agent-a', name: 'Alpha' })],
      })
    })
    // Nothing is waiting now, so the total is the four that are running.
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (4)')
    const dot = screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Working... (4)')
  })

  it('settles to the idle line when everything finishes, with no count left behind', () => {
    const b = mount({
      state: {
        rows: [row({ agent: 'agent-a', name: 'Alpha', running: true, queuedWorkers: 1 })],
        activeSubagents: { 'agent-a': 1 },
      },
    })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working... (2)')
    act(() => {
      b.inbox.set({
        ...b.inbox.getSnapshot(),
        rows: [row({ agent: 'agent-a', name: 'Alpha' })],
        activeSubagents: {},
      })
    })
    const line = screen.getByTestId('ui-inbox-state-agent-a').textContent ?? ''
    expect(line).toBe('5m ago')
    expect(line).not.toContain('/')
    expect(line).not.toContain('(0)')
    expect(screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="online"]')).not.toBeNull()
  })

  it('never renders a slash or a (0), whatever the queue says', () => {
    const cases: { running: boolean; active: number; queued: number; line: string }[] = [
      // A queue with nothing running is still working, with the queue counted.
      { running: true, active: 0, queued: 2, line: 'Working... (2)' },
      { running: false, active: 0, queued: 3, line: 'Working... (3)' },
      { running: false, active: 0, queued: 0, line: '5m ago' },
      { running: false, active: 1, queued: 0, line: 'Working... (1)' },
      { running: false, active: 1, queued: 1, line: 'Working... (2)' },
      { running: true, active: 2, queued: 1, line: 'Working... (3)' },
    ]
    for (const item of cases) {
      mount({
        state: {
          rows: [row({ agent: 'agent-a', name: 'Alpha', running: item.running, queuedWorkers: item.queued })],
          activeSubagents: item.active === 0 ? {} : { 'agent-a': item.active },
        },
      })
      const line = screen.getByTestId('ui-inbox-state-agent-a').textContent ?? ''
      expect(line).toBe(item.line)
      expect(line).not.toContain('/')
      expect(line).not.toContain('(0)')
      expect(line.endsWith('(')).toBe(false)
      cleanup()
    }
  })

  it('carries the total into the rail dot', () => {
    mount({
      wide: false,
      state: { rows: [row({ agent: 'agent-a', name: 'Alpha', queuedWorkers: 2 })], activeSubagents: { 'agent-a': 3 } },
    })
    const dot = screen.getByTestId('ui-inbox-rail-agent-a').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Working... (5)')
    expect(screen.getByTestId('ui-inbox-rail-agent-a').getAttribute('aria-label'))
      .toBe('Open your conversation with Alpha')
  })

  it('never renders a (0) suffix, and leaves the idle line alone when nothing runs', () => {
    mount({ state: { rows: [row({ agent: 'agent-a', name: 'Alpha' })] } })
    const line = screen.getByTestId('ui-inbox-state-agent-a').textContent ?? ''
    expect(line).toBe('5m ago')
    expect(line).not.toContain('(0)')
    expect(screen.getByTestId('ui-inbox-open-agent-a').querySelector('[data-presence="online"]')).not.toBeNull()
  })

  it('carries the working copy and count into the rail dot', () => {
    mount({ wide: false, state: { rows: [row({ agent: 'agent-a', name: 'Alpha', running: true })], activeSubagents: { 'agent-a': 2 } } })
    const dot = screen.getByTestId('ui-inbox-rail-agent-a').querySelector('[data-presence="running"]')
    expect(dot?.getAttribute('aria-label')).toBe('Working... (2)')
    expect(screen.getByTestId('ui-inbox-rail-agent-a').getAttribute('aria-label'))
      .toBe('Open your conversation with Alpha')
  })

  it('derives a monogram from the name the server sent', () => {
    mount()
    expect(screen.getByTestId('ui-inbox-open-agent-a').textContent).toContain('A')
  })

  it('opens the row on one click and never renders a New Session control', () => {
    const b = mount()
    fireEvent.click(screen.getByTestId('ui-inbox-open-agent-b'))
    expect(b.open).toHaveBeenCalledTimes(1)
    expect(b.open).toHaveBeenCalledWith('agent-b')
    expect(screen.queryByText('New Session')).toBeNull()
  })

  it('marks the open row and shows a busy line while its call runs', () => {
    mount({ state: { openAgent: 'agent-a', busy: ['agent-a'] } })
    expect(screen.getByTestId('ui-inbox-open-agent-a').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Opening…')
  })
})

describe('inbox panel: the row menu and its one action', () => {
  it('offers exactly one action, Clear, and opens the confirmation', async () => {
    const b = mount()
    expect(screen.queryAllByRole('menuitem')).toHaveLength(0)
    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    const items = await screen.findAllByRole('menuitem')
    expect(items).toHaveLength(1)
    expect(items[0]?.textContent).toBe('Clear')
    fireEvent.click(items[0]!)
    expect(screen.getByRole('dialog').getAttribute('aria-label'))
      .toBe('Clear your conversation with Alpha?')
    expect(screen.getByRole('dialog').textContent).toContain('The messages are permanently deleted')
    expect(b.clear).not.toHaveBeenCalled()
  })

  it('confirms once with the row the dialog named', async () => {
    const b = mount()
    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-b'))
    fireEvent.click((await screen.findAllByRole('menuitem'))[0]!)
    fireEvent.click(screen.getByTestId('ui-inbox-confirm-clear'))
    expect(b.clear).toHaveBeenCalledTimes(1)
    expect(b.clear).toHaveBeenCalledWith('agent-b')
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
  })

  it('cancels on Escape without clearing', async () => {
    const b = mount()
    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    fireEvent.click((await screen.findAllByRole('menuitem'))[0]!)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(b.clear).not.toHaveBeenCalled()
  })

  it('cancels on the Cancel button and on a mask click', async () => {
    const b = mount()
    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    fireEvent.click((await screen.findAllByRole('menuitem'))[0]!)
    fireEvent.click(screen.getByTestId('ui-inbox-confirm-cancel'))
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })

    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    fireEvent.click((await screen.findAllByRole('menuitem'))[0]!)
    const mask = document.querySelector('[class*="mask"]')
    expect(mask).not.toBeNull()
    fireEvent.click(mask!)
    await waitFor(() => { expect(screen.queryByRole('dialog')).toBeNull() })
    expect(b.clear).not.toHaveBeenCalled()
  })

  it('cancels the menu itself on Escape and outside pointer-down', async () => {
    mount()
    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
    fireEvent.keyDown(document, { key: 'Escape' })
    await waitFor(() => { expect(screen.queryAllByRole('menuitem')).toHaveLength(0) })

    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
    fireEvent.pointerDown(document.body)
    await waitFor(() => { expect(screen.queryAllByRole('menuitem')).toHaveLength(0) })
  })

  it('is keyboard reachable: the trigger is a button with menu semantics', async () => {
    mount()
    const trigger = screen.getByTestId('ui-inbox-menu-agent-a')
    expect(trigger.tagName).toBe('BUTTON')
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    trigger.focus()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    expect(await screen.findAllByRole('menuitem')).toHaveLength(1)
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
  })

  it('traps focus inside the confirmation dialog', async () => {
    mount()
    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    fireEvent.click((await screen.findAllByRole('menuitem'))[0]!)
    const dialog = screen.getByRole('dialog')
    const cancel = screen.getByTestId('ui-inbox-confirm-cancel')
    await waitFor(() => { expect(document.activeElement).toBe(cancel) })

    const confirm = screen.getByTestId('ui-inbox-confirm-clear')
    confirm.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // Tab off the last control wraps to the first, never out of the dialog.
    expect(dialog.contains(document.activeElement)).toBe(true)

    cancel.focus()
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true })
    expect(dialog.contains(document.activeElement)).toBe(true)
  })
})

describe('inbox panel: failures, states and the rail', () => {
  it('shows a refused clear plainly and keeps the row populated', () => {
    mount({ state: { notices: { 'agent-a': 'clear-refused' } } })
    expect(screen.getByTestId('ui-inbox-notice-agent-a').textContent)
      .toBe('The conversation was not cleared. It still exists.')
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toContain('5m ago')
  })

  it('shows an open failure as an open failure', () => {
    mount({ state: { notices: { 'agent-c': 'hostUnavailable' } } })
    expect(screen.getByTestId('ui-inbox-notice-agent-c').textContent)
      .toBe('That conversation could not be opened. Try again in a moment.')
  })

  it('renders the loading screen before the first read lands', () => {
    mount({ state: { status: 'loading', rows: [], person: null } })
    expect(screen.getByTestId('ui-inbox-loading').textContent).toBe('Loading conversations…')
    expect(screen.queryAllByTestId(/^ui-inbox-row-/)).toHaveLength(0)
  })

  it('renders a plain explanatory screen for a person whose deployment composes nothing', () => {
    mount({ state: { status: 'ready', rows: [] } })
    expect(screen.getByTestId('ui-inbox-empty').textContent).toContain('No agents yet')
    expect(screen.queryByTestId('ui-inbox-refused')).toBeNull()
  })

  it('renders the profile refusal with no retry control', () => {
    mount({ state: { status: 'refused', rows: [] } })
    const refused = screen.getByTestId('ui-inbox-refused')
    expect(refused.textContent).toContain('not available to this profile')
    expect(screen.queryByTestId('ui-inbox-retry')).toBeNull()
    expect(screen.queryByText('Try again')).toBeNull()
  })

  it('renders a failed read with its reason and a retry control that re-reads', () => {
    const b = mount({ state: { status: 'error', rows: [], loadError: 'unavailable' } })
    expect(screen.getByTestId('ui-inbox-error').textContent).toContain('The harness is restarting')
    fireEvent.click(screen.getByTestId('ui-inbox-retry'))
    expect(b.load).toHaveBeenCalledTimes(1)
  })

  it('keeps usable rows beside a failed refresh instead of blanking them', () => {
    mount({ state: { status: 'error', loadError: 'transport' } })
    expect(screen.getByTestId('ui-inbox-banner').textContent).toContain('could not be reached')
    expect(screen.getAllByTestId(/^ui-inbox-row-/)).toHaveLength(3)
  })

  it('re-reads on demand from the header control', () => {
    const b = mount()
    fireEvent.click(screen.getByTestId('ui-inbox-refresh'))
    expect(b.load).toHaveBeenCalledTimes(1)
  })

  it('renders one glyph per agent in the rail and opens on click', () => {
    const b = mount({ wide: false })
    expect(screen.getByTestId('ui-inbox-rail')).toBeDefined()
    expect(screen.getByTestId('ui-inbox-rail-agent-c').getAttribute('aria-label'))
      .toBe('Open your conversation with Gamma')
    fireEvent.click(screen.getByTestId('ui-inbox-rail-agent-c'))
    expect(b.expandSidebar).toHaveBeenCalledTimes(1)
    expect(b.open).toHaveBeenCalledWith('agent-c')
  })

  it('rail glyphs keep each row name, its selected state and the channel row', () => {
    const b = mount({ wide: false, state: { openAgent: 'agent-a' } })
    expect(screen.getByTestId('ui-inbox-rail-agent-a').getAttribute('aria-label'))
      .toBe('Open your conversation with Alpha')
    expect(screen.getByTestId('ui-inbox-rail-agent-a').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('ui-inbox-rail-agent-b').getAttribute('aria-current')).toBeNull()
    // The channel group rides the rail with the channel's own row name.
    const channel = screen.getByTestId('agent-channel-rail-delta-darwin')
    expect(channel.getAttribute('aria-label')).toBe('Delta-Darwin')
    expect(channel.getAttribute('aria-current')).toBeNull()
    fireEvent.click(channel)
    expect(b.openChannel).toHaveBeenCalledWith('delta-darwin')
    // A selected channel owns the current marker, and the agent row lets go of it.
    act(() => {
      b.channels.set({
        ...b.channels.getSnapshot(),
        selected: { id: 'delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] },
      })
    })
    expect(screen.getByTestId('agent-channel-rail-delta-darwin').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('ui-inbox-rail-agent-a').getAttribute('aria-current')).toBeNull()
  })

  it('the rail carries no status copy, timestamp, header or menu', () => {
    mount({ wide: false })
    // Not rendered at all — the rail is a heads-only surface, so there is
    // nothing here that a keyboard could reach while it cannot be seen.
    expect(screen.queryAllByTestId(/^ui-inbox-state-/)).toHaveLength(0)
    expect(screen.queryAllByTestId(/^ui-inbox-menu-/)).toHaveLength(0)
    expect(screen.queryAllByTestId(/^ui-inbox-row-/)).toHaveLength(0)
    expect(screen.queryByTestId('ui-inbox-refresh')).toBeNull()
    expect(screen.queryByTestId('ui-inbox-panel')).toBeNull()
    expect(screen.queryByText('Working...')).toBeNull()
    expect(screen.queryByText('5m ago')).toBeNull()
    expect(screen.queryByText('Inbox')).toBeNull()
    // The only interactive nodes are the glyphs themselves.
    const buttons = screen.getAllByRole('button')
    expect(buttons.every(button => /rail/.test(button.getAttribute('data-testid') ?? ''))).toBe(true)
  })

  it('a channel rail glyph reflects its participants and selects the channel', () => {
    // A channel whose participants ARE available rows: the dot reads online,
    // and the glyph carries the channel's own name and selected state.
    const b = mount({
      wide: false,
      state: {
        rows: [
          row({ agent: 'delta', name: 'Delta' }),
          row({ agent: 'darwin', name: 'Darwin' }),
        ],
      },
    })
    b.channels.set({
      rows: [{ id: 'delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }],
      selected: null, messages: [], error: null, loading: false,
    })
    const glyph = screen.getByTestId('agent-channel-rail-delta-darwin')
    const dot = glyph.querySelector('[data-presence]')
    expect(dot?.getAttribute('data-presence')).toBe('online')
    expect(dot?.getAttribute('aria-label')).toBe('Online')
    fireEvent.click(glyph)
    expect(b.openChannel).toHaveBeenCalledWith('delta-darwin')
  })

  it('a rail glyph in portrait opens in place instead of unfolding the inbox', () => {
    const b = mount({ wide: false, portrait: true })
    fireEvent.click(screen.getByTestId('ui-inbox-rail-agent-c'))
    expect(b.expandSidebar).not.toHaveBeenCalled()
    expect(b.collapseOnSelection).toHaveBeenCalledTimes(1)
    expect(b.open).toHaveBeenCalledWith('agent-c')
    // Same for a channel glyph: portrait never unfolds the menu over the chat.
    fireEvent.click(screen.getByTestId('agent-channel-rail-delta-darwin'))
    expect(b.expandSidebar).not.toHaveBeenCalled()
    expect(b.openChannel).toHaveBeenCalledWith('delta-darwin')
  })
})

describe('inbox panel: auto-collapse on selection', () => {
  it('an agent row click collapses the column, in that click', () => {
    const b = mount()
    fireEvent.click(screen.getByTestId('ui-inbox-open-agent-a'))
    expect(b.collapseOnSelection).toHaveBeenCalledTimes(1)
    expect(b.open).toHaveBeenCalledWith('agent-a')
  })

  it('a channel row click collapses the column, in that click', () => {
    const b = mount()
    fireEvent.click(screen.getByTestId('agent-channel-open-delta-darwin'))
    expect(b.collapseOnSelection).toHaveBeenCalledTimes(1)
    expect(b.openChannel).toHaveBeenCalledWith('delta-darwin')
  })

  it('an older owner share that supplies neither prop behaves as landscape', () => {
    // Registrants that predate the portrait contract simply do not pass the two
    // optional props: the panel must still render, still select, and never
    // collapse the column — absent means landscape.
    const inbox = store()
    const open = vi.fn()
    const props = {
      wide: true,
      expandSidebar: vi.fn(),
      collapseSidebar: vi.fn(),
      useChannels: bindSnapshotSelector(createSnapshotStore<ChannelState>({
        rows: [], selected: null, messages: [], error: null, loading: false,
      })),
      openChannel: vi.fn(),
      clearChannel: vi.fn(),
      useSessions: (() => { throw new Error('unused') }) as never,
      useWorkspaces: (() => { throw new Error('unused') }) as never,
      useInbox: bindSnapshotSelector(inbox),
      load: vi.fn(),
      open,
      clear: vi.fn(),
      t,
    } as InboxPanelProps
    render(<InboxPanel {...props} />)
    fireEvent.click(screen.getByTestId('ui-inbox-open-agent-a'))
    expect(open).toHaveBeenCalledWith('agent-a')
  })

  it('nothing collapses without a selection: no render, no read, no menu', () => {
    const b = mount()
    // Re-render through a store write that is not a selection.
    act(() => { b.inbox.set({ ...b.inbox.getSnapshot(), busy: ['agent-a'] }) })
    fireEvent.click(screen.getByTestId('ui-inbox-refresh'))
    fireEvent.click(screen.getByTestId('ui-inbox-menu-agent-a'))
    expect(b.collapseOnSelection).not.toHaveBeenCalled()
  })
})

describe('inbox panel: sub-agents are NOT in this sidebar', () => {
  /**
   * Owen, 2026-10-23: "issue: sub-agents is appears in my inbox/agent-channel
   * sidebar." The roster moved to the OTHER interface of the same shell
   * (EpsilonPanel), so the inbox must render none of it even when the
   * controller's snapshot carries a populated roster — a person reading their
   * inbox or a peer channel sees their agents and channels and nothing else.
   */
  const WORKERS = [
    { id: 'w-1' as never, parentId: 's-agent-a' as never, index: 1, label: 'Review the frontend', running: true, mode: 'continuable' as const, damaged: false },
    { id: 'w-2' as never, parentId: 's-agent-a' as never, index: 2, running: false, mode: 'one-shot' as const, damaged: false },
    { id: 'w-bad' as never, parentId: 's-agent-a' as never, index: 3, running: false, damaged: true },
  ]

  it('draws no sub-agent row, heading or notice, whatever the roster holds', () => {
    mount({
      state: {
        workers: WORKERS,
        workersState: 'ready',
        openWorkerId: 'w-2' as never,
        workerNotice: { id: 'w-1' as never, code: 'worker-unavailable' },
      },
    })
    // Nothing from the epsilon interface's tree: absent markup, not hidden.
    expect(screen.queryByTestId('ui-epsilon-panel')).toBeNull()
    expect(screen.queryByTestId('ui-epsilon-rail')).toBeNull()
    expect(screen.queryAllByTestId(/^ui-epsilon-/)).toHaveLength(0)
    // And no legacy worker-testid either, so a resurrected section is caught.
    expect(screen.queryAllByTestId(/^ui-inbox-worker/)).toHaveLength(0)
    expect(screen.queryByText('Delta sub-agents')).toBeNull()
    expect(screen.queryByText('Epsilon 1')).toBeNull()
    expect(screen.queryByText('Review the frontend')).toBeNull()
    // The rows it DOES own are still there, so this is an absence of sub-agents
    // rather than an empty panel.
    expect(screen.getByTestId('ui-inbox-row-agent-a')).toBeDefined()
    expect(screen.getByTestId('agent-channel-row-delta-darwin')).toBeDefined()
  })

  it('keeps the inbox rows and the channel section when the roster read failed', () => {
    mount({ state: { workers: WORKERS, workersState: 'error' } })
    // A failed catalog belongs to the epsilon interface; it must not push a
    // banner or a retry control into the inbox's own failure surfaces.
    expect(screen.queryAllByTestId(/^ui-epsilon-/)).toHaveLength(0)
    expect(screen.queryByText('Delta’s sub-agents could not load')).toBeNull()
    expect(screen.getByTestId('ui-inbox-row-agent-a')).toBeDefined()
  })
})
