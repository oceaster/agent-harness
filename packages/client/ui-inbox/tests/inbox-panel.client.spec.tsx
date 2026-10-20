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
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { InboxAgentRow } from '../src/client/inbox-api.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { InboxPanel } from '../src/client/InboxPanel.tsx'
import type { InboxState } from '../src/client/inbox-controller.ts'
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
    ...initial,
  })
}

function mount(overrides: {
  state?: Partial<InboxState>
  wide?: boolean
} = {}) {
  const inbox = store(overrides.state)
  const open = vi.fn()
  const clear = vi.fn()
  const load = vi.fn()
  const expandSidebar = vi.fn()
  // The runtime share also carries the global session/workspace hooks; the
  // panel never reads them, so they are never-called stubs.
  const neverHook = (() => { throw new Error('the inbox panel must not read global hooks') }) as never
  const props: InboxPanelProps = {
    wide: overrides.wide ?? true,
    expandSidebar,
    useSessions: neverHook,
    useWorkspaces: neverHook,
    useInbox: bindSnapshotSelector(inbox),
    load,
    open,
    clear,
    t,
  }
  const view = render(<InboxPanel {...props} />)
  return { ...view, inbox, open, clear, load, expandSidebar }
}

describe('inbox panel: rows', () => {
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

  it('shows the running indicator while the agent is working', () => {
    mount({ state: { rows: [row({ agent: 'agent-a', name: 'Alpha', running: true })] } })
    expect(screen.getByTestId('ui-inbox-state-agent-a').textContent).toBe('Working…')
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
})
