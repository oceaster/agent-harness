// @vitest-environment jsdom
/**
 * EpsilonPanel: the OTHER interface of the one shell — the sidebar of Delta's
 * sub-agents, and the proof that the two interfaces stay "SAME SAME, DIFFERENT,
 * BUT SAME" (Owen, 2026-10-23).
 *
 * These cases came from `inbox-panel.client.spec.tsx`, where they asserted that
 * the INBOX sidebar listed sub-agents — the very thing Owen asked to stop. They
 * moved here with the rows, and the inbox spec now asserts the absence instead:
 * what is tested is which interface renders what, not how many rows exist.
 *
 * The suite feeds props directly (a driven store instance plus the injected
 * callbacks) and asserts user-visible behavior: one row per worker in Delta's
 * catalog order, the household's naming rule (long form once, "E1" afterwards),
 * the durable task line, the open verb receiving the row's own id, the damaged
 * statement that is not a door, the refused address said on the row, and the
 * three non-list states (nothing read yet, nothing there, read failed). It also
 * holds the SAMENESS rule down against the inbox panel itself: both sides wear
 * the same `li` and the same row button, so a styling change cannot silently
 * fork the two interfaces.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InboxAgentRow } from '../src/client/inbox-api.ts'
import { EpsilonPanel } from '../src/client/EpsilonPanel.tsx'
import { InboxPanel } from '../src/client/InboxPanel.tsx'
import type { InboxState, InboxWorkerRow } from '../src/client/inbox-controller.ts'
import type { ChannelState } from '../src/client/channel-controller.ts'
import { en } from '../src/client/locales.ts'
import type { InboxPanelProps } from '../src/client/slots.ts'

afterEach(cleanup)
// The panels read one clock per render; pin it so relative times are stable.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-06-01T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const t: InboxPanelProps['t'] = makeTranslate(en, commonZh)

const NOW_SECONDS = new Date('2026-06-01T12:00:00Z').getTime() / 1000

const agentRow = (overrides: Partial<InboxAgentRow> & Pick<InboxAgentRow, 'agent' | 'name'>): InboxAgentRow => ({
  hasConversation: true,
  sessionId: `s-${overrides.agent}`,
  blank: false,
  lastActivityAt: NOW_SECONDS - 300,
  running: false,
  ...overrides,
})

const ROWS: InboxAgentRow[] = [
  agentRow({ agent: 'agent-a', name: 'Alpha' }),
  agentRow({ agent: 'delta', name: 'Delta' }),
]

/**
 * Three workers of Delta's conversation, as the roster folds them out of the
 * catalog: one continuable with a recorded task, one one-shot without a label,
 * and one the harness could not identify.
 */
const WORKERS: InboxWorkerRow[] = [
  {
    id: 'w-1' as never, parentId: 's-delta' as never, index: 1,
    label: 'Review the frontend', running: true, mode: 'continuable', damaged: false,
  },
  {
    id: 'w-2' as never, parentId: 's-delta' as never, index: 2,
    running: false, mode: 'one-shot', damaged: false,
  },
  {
    id: 'w-bad' as never, parentId: 's-delta' as never, index: 3, running: false, damaged: true,
  },
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

/**
 * Mount the epsilon sidebar over a driven store.
 * @param overrides - pieces of the snapshot and the shell's shape to drive.
 * @returns the render result plus every injected callback, for click assertions.
 */
function mount(overrides: {
  state?: Partial<InboxState>
  wide?: boolean
  portrait?: boolean
} = {}) {
  const inbox = store(overrides.state)
  const openWorker = vi.fn()
  const loadWorkers = vi.fn()
  const expandSidebar = vi.fn()
  const collapseSidebar = vi.fn()
  const collapseOnSelection = vi.fn()
  const props: InboxPanelProps = {
    wide: overrides.wide ?? true,
    portrait: overrides.portrait ?? false,
    expandSidebar,
    collapseSidebar,
    collapseOnSelection,
    // The epsilon interface paints no channel row and no agent row, so these
    // shares are never read: a stub that throws is how that stays true.
    useChannels: (() => { throw new Error('the epsilon panel must not read channels') }) as never,
    openChannel: vi.fn(),
    clearChannel: vi.fn(),
    useSessions: (() => { throw new Error('the epsilon panel must not read sessions') }) as never,
    useWorkspaces: (() => { throw new Error('the epsilon panel must not read workspaces') }) as never,
    useInbox: bindSnapshotSelector(inbox),
    load: vi.fn(),
    open: vi.fn(),
    openWorker,
    loadWorkers,
    clear: vi.fn(),
    t,
  }
  const view = render(<EpsilonPanel {...props} />)
  return {
    ...view, inbox, openWorker, loadWorkers, expandSidebar, collapseSidebar, collapseOnSelection, props,
  }
}

describe('epsilon panel: the roster of Delta\'s sub-agents', () => {
  it('lists Delta\'s workers under the section Owen asked for by name', () => {
    mount({ state: { workers: WORKERS, workersState: 'ready' } })
    expect(screen.getByTestId('ui-epsilon-panel')).toBeDefined()
    // Owen: "instead of seeing inbox & agent channels in the sidebar... I see the
    // 'Delta sub-agents' list."
    expect(screen.getByText('Delta sub-agents')).toBeDefined()
    for (const worker of WORKERS) expect(screen.getByTestId(`ui-epsilon-row-${worker.id}`)).toBeDefined()
  })

  it('paints no agent row and no channel row, however much the snapshot carries', () => {
    mount({ state: { workers: WORKERS, workersState: 'ready' } })
    // The sibling interface's rows. Absent, not hidden: nothing in this tree
    // names an agent or a channel, which is the composed claim at unit scale.
    expect(screen.queryByTestId('ui-inbox-row-agent-a')).toBeNull()
    expect(screen.queryByTestId('ui-inbox-row-delta')).toBeNull()
    expect(screen.queryByTestId('ui-inbox-open-agent-a')).toBeNull()
    expect(screen.queryByTestId('agent-channel-row-delta-darwin')).toBeNull()
    expect(screen.queryByText('Inbox')).toBeNull()
    expect(screen.queryByText('Agent Channels')).toBeNull()
  })

  it('names each worker once, long form, with the durable task on its second line', () => {
    mount({ state: { workers: WORKERS, workersState: 'ready' } })
    expect(screen.getByText('Epsilon 1')).toBeDefined()
    expect(screen.getByText('Epsilon 2')).toBeDefined()
    expect(screen.getByText('Epsilon 3')).toBeDefined()
    expect(screen.getByText('Review the frontend')).toBeDefined()
    // A worker with no recorded label says so rather than repeating its name.
    expect(screen.getByTestId('ui-epsilon-state-w-2').textContent).toBe('No task recorded')
    // The short form is the avatar's monogram and nothing else on the row.
    expect(screen.getByTestId('ui-epsilon-open-w-1').textContent).toContain('E1')
    expect(screen.getAllByText('Epsilon 1')).toHaveLength(1)
  })

  it('renders the rows with the inbox row component and styling', () => {
    // The SAMENESS half of "SAME SAME, DIFFERENT, BUT SAME": the two interfaces
    // must not fork their row markup or their classes, or the next styling
    // change lands on one of them only. Mounted side by side, the same `li`, the
    // same row button and the same inner line have to be one styling decision.
    const epsilon = mount({ state: { workers: WORKERS, workersState: 'ready' } })
    const workerRow = screen.getByTestId('ui-epsilon-row-w-1')
    const workerButton = screen.getByTestId('ui-epsilon-open-w-1')
    expect(workerButton.querySelector('[data-presence="running"]')).not.toBeNull()
    epsilon.unmount()
    const inboxStore = store()
    render(<InboxPanel {...{
      ...epsilon.props,
      useInbox: bindSnapshotSelector(inboxStore),
      useChannels: bindSnapshotSelector(createSnapshotStore<ChannelState>({
        rows: [], selected: null, messages: [], error: null, loading: false,
      })),
    }} />)
    const referenceRow = screen.getByTestId('ui-inbox-row-agent-a')
    const referenceButton = screen.getByTestId('ui-inbox-open-agent-a')
    expect(workerRow.tagName).toBe(referenceRow.tagName)
    expect(workerRow.className).toBe(referenceRow.className)
    expect(workerButton.tagName).toBe(referenceButton.tagName)
    expect(workerButton.className).toBe(referenceButton.className)
    expect(workerButton.firstElementChild?.className).toBe(referenceButton.firstElementChild?.className)
    expect(workerButton.lastElementChild?.className).toBe(referenceButton.lastElementChild?.className)
  })

  it('opens a worker by id through the injected verb and marks the open one', () => {
    const b = mount({ state: { workers: WORKERS, workersState: 'ready', openWorkerId: 'w-2' as never } })
    expect(screen.getByTestId('ui-epsilon-open-w-2').getAttribute('aria-current')).toBe('true')
    expect(screen.getByTestId('ui-epsilon-open-w-1').getAttribute('aria-current')).toBeNull()
    fireEvent.click(screen.getByTestId('ui-epsilon-open-w-1'))
    expect(b.openWorker).toHaveBeenCalledWith('w-1')
    // The address is the whole call: opening a worker never goes through the
    // inbox API, which is what keeps a worker conversation read-only.
    expect(b.props.open).not.toHaveBeenCalled()
    expect(b.collapseOnSelection).toHaveBeenCalled()
  })

  it('neither offers nor opens a child the harness could not identify', () => {
    const b = mount({ state: { workers: WORKERS, workersState: 'ready' } })
    const damaged = screen.getByTestId('ui-epsilon-open-w-bad') as HTMLButtonElement
    expect(damaged.disabled).toBe(true)
    expect(damaged.textContent).toContain('The harness cannot read this sub-agent’s record.')
    fireEvent.click(damaged)
    expect(b.openWorker).not.toHaveBeenCalled()
  })

  it('says a refused address on the row instead of leaving the click silent', () => {
    mount({
      state: {
        workers: WORKERS, workersState: 'ready',
        workerNotice: { id: 'w-1' as never, code: 'worker-unavailable' },
      },
    })
    expect(screen.getByTestId('ui-epsilon-notice-w-1').textContent)
      .toBe('This sub-agent is no longer available.')
    expect(screen.queryByTestId('ui-epsilon-notice-w-2')).toBeNull()
  })

  it('refreshes through the injected verb', () => {
    const b = mount({ state: { workers: WORKERS, workersState: 'ready' } })
    fireEvent.click(screen.getByTestId('ui-epsilon-refresh'))
    expect(b.loadWorkers).toHaveBeenCalledTimes(1)
  })

  it('says Delta has no sub-agents rather than painting an empty column', () => {
    mount({ state: { workers: [], workersState: 'ready' } })
    expect(screen.getByTestId('ui-epsilon-empty')).toBeDefined()
    expect(screen.getByText('No Delta sub-agents yet')).toBeDefined()
    expect(screen.queryAllByTestId(/^ui-epsilon-row-/)).toHaveLength(0)
  })

  it('distinguishes a roster that was never asked for from one that is empty', () => {
    // `idle` is the inbox interface's state, never the epsilon one's; a panel
    // mounted before the first read must not print "no sub-agents yet".
    mount({ state: { workers: [], workersState: 'idle' } })
    expect(screen.getByTestId('ui-epsilon-loading')).toBeDefined()
    expect(screen.queryByTestId('ui-epsilon-empty')).toBeNull()
  })

  it('states a failed read and offers the retry that fixes it', () => {
    const b = mount({ state: { workers: [], workersState: 'error' } })
    expect(screen.getByTestId('ui-epsilon-error')).toBeDefined()
    fireEvent.click(screen.getByTestId('ui-epsilon-retry'))
    expect(b.loadWorkers).toHaveBeenCalledTimes(1)
  })

  it('keeps rows from an earlier read usable beside a failed refresh', () => {
    const b = mount({ state: { workers: WORKERS, workersState: 'error' } })
    expect(screen.getByTestId('ui-epsilon-banner')).toBeDefined()
    // The rows survive the failure: a worker list that empties itself on one
    // bad read reads as "Delta has no workers", which is a different fact.
    expect(screen.getByTestId('ui-epsilon-row-w-1')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    expect(b.loadWorkers).toHaveBeenCalledTimes(1)
  })
})

describe('epsilon panel: the rail', () => {
  it('folds to one glyph per worker, keeping each row\'s accessible name', () => {
    const b = mount({ wide: false, state: { workers: WORKERS, workersState: 'ready' } })
    expect(screen.getByTestId('ui-epsilon-rail')).toBeDefined()
    expect(screen.queryByTestId('ui-epsilon-panel')).toBeNull()
    expect(screen.getByTestId('ui-epsilon-glyph-w-1').getAttribute('aria-label')).toBe('Open sub-agent Epsilon 1')
    // A folded column paints names and nothing else: no task lines, no statuses.
    expect(screen.queryByText('Review the frontend')).toBeNull()
    fireEvent.click(screen.getByTestId('ui-epsilon-glyph-w-1'))
    expect(b.openWorker).toHaveBeenCalledWith('w-1')
    expect(b.expandSidebar).toHaveBeenCalledTimes(1)
    expect(b.collapseOnSelection).toHaveBeenCalled()
  })

  it('does not expand the column in portrait, where the transcript has the screen', () => {
    const b = mount({ wide: false, portrait: true, state: { workers: WORKERS, workersState: 'ready' } })
    fireEvent.click(screen.getByTestId('ui-epsilon-glyph-w-1'))
    expect(b.expandSidebar).not.toHaveBeenCalled()
    expect(b.collapseOnSelection).toHaveBeenCalled()
    expect(b.openWorker).toHaveBeenCalledWith('w-1')
  })

  it('carries the damaged statement onto the glyph as a disabled control', () => {
    const b = mount({ wide: false, state: { workers: WORKERS, workersState: 'ready' } })
    const glyph = screen.getByTestId('ui-epsilon-glyph-w-bad') as HTMLButtonElement
    expect(glyph.disabled).toBe(true)
    fireEvent.click(glyph)
    expect(b.openWorker).not.toHaveBeenCalled()
  })
})

describe('epsilon panel: nothing about a worker transcript', () => {
  it('paints no hierarchy header, no composer seat and no branch control', () => {
    // Owen: a worker's conversation is read-only, and the harness's internal
    // parent/child naming is not exposed. Whatever the shell paints there, this
    // sidebar must not be the second author of it.
    mount({ state: { workers: WORKERS, workersState: 'ready' } })
    expect(screen.queryByText(/parent/i)).toBeNull()
    expect(screen.queryByText(/sub-agent session/i)).toBeNull()
    expect(screen.queryByRole('textbox')).toBeNull()
    expect(screen.queryByTestId('ui-composer')).toBeNull()
  })
})
