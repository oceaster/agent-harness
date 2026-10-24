// @vitest-environment jsdom
/**
 * The occupant of `sidebar.workspaces`: BOTH interfaces of the one shell,
 * mounted once, one of them visible — and the hidden one doing NOTHING.
 *
 * Owen, 2026-10-24: "if closed, it's actually just 'not-visible'". The failure
 * mode that phrasing rules out is a hidden surface that keeps working: a panel
 * that is still subscribed re-renders on every store frame, which costs more
 * than the page load it replaced. So the assertions here are behavioural, not
 * structural:
 *
 *   - a surface that has been shown stays mounted (the same DOM node), so a
 *     trip elsewhere and back costs no mount and keeps whatever the person left
 *     in it;
 *   - the hidden surface holds NO subscription and does not re-render when its
 *     store writes — proven by a store source that counts subscriptions, and by
 *     `Date.now`, which InboxPanel reads exactly once per render;
 *   - showing it again paints what happened while it was hidden (a paused read
 *     must not become a stale panel);
 *   - a page the parent does not drive by message still contains exactly one
 *     interface, which is what keeps the composed checks that hold the two
 *     interfaces apart by markup true on a cold load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { InboxAgentRow } from '../src/client/inbox-api.ts'
import { SurfacePanels } from '../src/client/SurfacePanels.tsx'
import type { InboxState, InboxWorkerRow } from '../src/client/inbox-controller.ts'
import type { ChannelState } from '../src/client/channel-controller.ts'
import type { SurfaceSnapshot } from '../src/client/surface-controller.ts'
import { en } from '../src/client/locales.ts'
import type { InboxPanelProps } from '../src/client/slots.ts'

afterEach(cleanup)
// One clock read per InboxPanel render is this suite's render counter.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-06-01T12:00:00Z')) })
afterEach(() => { vi.useRealTimers() })

const t: InboxPanelProps['t'] = makeTranslate(en, commonZh)
const NOW_SECONDS = new Date('2026-06-01T12:00:00Z').getTime() / 1000

const row = (agent: string, overrides: Partial<InboxAgentRow> = {}): InboxAgentRow => ({
  agent, name: agent, hasConversation: true, sessionId: `s-${agent}`, blank: false,
  lastActivityAt: NOW_SECONDS - 300, running: false, ...overrides,
})

const ROWS: InboxAgentRow[] = [row('delta', { name: 'Delta' }), row('darwin', { name: 'Darwin' })]

const WORKERS: InboxWorkerRow[] = [
  { id: 'w-1' as never, parentId: 's-delta' as never, index: 1, label: 'Review the frontend', running: false, mode: 'continuable', damaged: false },
]

/** The inbox snapshot every case starts from. */
function inboxState(overrides: Partial<InboxState> = {}): InboxState {
  return {
    status: 'ready',
    person: { id: 'p-1', name: 'Person One' },
    rows: ROWS,
    loadError: null,
    busy: [],
    notices: {},
    openAgent: null,
    activeSubagents: {},
    workers: WORKERS,
    workersState: 'ready',
    openWorkerId: null,
    workerNotice: null,
    ...overrides,
  }
}

/**
 * A store that counts what a hidden surface must not do: hold a subscription,
 * or read the snapshot on somebody else's frame.
 * @param store - the real store.
 * @returns the same store behind counters.
 */
function counted<T>(store: SnapshotStore<T>) {
  const counters = { reads: 0, live: 0, total: 0 }
  const proxy: SnapshotStore<T> = {
    getSnapshot: () => { counters.reads += 1; return store.getSnapshot() },
    subscribe: (listener) => {
      counters.total += 1
      counters.live += 1
      const stop = store.subscribe(listener)
      return () => { counters.live -= 1; stop() }
    },
    update: (mutator) => { store.update(mutator) },
    set: (next) => { store.set(next) },
  }
  return { proxy, counters }
}

/**
 * Mount the occupant over driven stores.
 * @param options - the surface to show, whether the parent drives it, and the payloads.
 * @returns the render result plus every store and callback the cases assert on.
 */
function mount(options: {
  surface?: 'inbox' | 'epsilons'
  resident?: boolean
  inbox?: Partial<InboxState>
} = {}) {
  const inbox = counted(createSnapshotStore<InboxState>(inboxState(options.inbox)))
  const channels = counted(createSnapshotStore<ChannelState>({ rows: [], selected: null, messages: [], error: null, loading: false }))
  const surface = createSnapshotStore<SurfaceSnapshot>({
    surface: options.surface ?? 'inbox',
    resident: options.resident ?? false,
  })
  const props: InboxPanelProps = {
    wide: true,
    portrait: false,
    expandSidebar: vi.fn(),
    collapseSidebar: vi.fn(),
    collapseOnSelection: vi.fn(),
    useChannels: bindSnapshotSelector(channels.proxy),
    openChannel: vi.fn(),
    clearChannel: vi.fn(),
    useSessions: (() => { throw new Error('the sidebar never reads global session hooks') }) as never,
    useWorkspaces: (() => { throw new Error('the sidebar never reads global workspace hooks') }) as never,
    useInbox: bindSnapshotSelector(inbox.proxy),
    sources: { inbox: inbox.proxy, channels: channels.proxy },
    surface,
    load: vi.fn(),
    open: vi.fn(),
    openWorker: vi.fn(),
    loadWorkers: vi.fn(),
    clear: vi.fn(),
    t,
  }
  const view = render(<SurfacePanels {...props} />)
  const show = (next: 'inbox' | 'epsilons'): void => {
    act(() => { surface.set({ ...surface.getSnapshot(), surface: next }) })
  }
  return { ...view, inbox, channels, surface, props, show }
}

describe('surface panels: mount once, one visible', () => {
  it('mounts only the interface a cold load names, so the other stays absent from the DOM', () => {
    mount({ surface: 'inbox' })
    expect(screen.getByTestId('ui-inbox-panel')).toBeDefined()
    expect(screen.queryByTestId('ui-surface-epsilons')).toBeNull()
    cleanup()
    mount({ surface: 'epsilons' })
    expect(screen.getByTestId('ui-epsilon-panel')).toBeDefined()
    expect(screen.queryByTestId('ui-surface-inbox')).toBeNull()
  })

  it('keeps both interfaces resident once the parent drives it, with one of them hidden', () => {
    mount({ surface: 'inbox', resident: true })
    const inboxPane = screen.getByTestId('ui-surface-inbox')
    const epsilonPane = screen.getByTestId('ui-surface-epsilons')
    expect(inboxPane.hidden).toBe(false)
    expect(epsilonPane.hidden).toBe(true)
    // Hidden is "not visible", not "gone": the surface is mounted and inert.
    expect(screen.getByTestId('ui-epsilon-panel')).toBeDefined()
  })

  it('switches by visibility alone: the DOM node that was shown is the one that comes back', () => {
    const b = mount({ surface: 'inbox', resident: true })
    const inboxNode = screen.getByTestId('ui-inbox-panel')
    b.show('epsilons')
    expect(screen.getByTestId('ui-surface-inbox').hidden).toBe(true)
    expect(screen.getByTestId('ui-surface-epsilons').hidden).toBe(false)
    b.show('inbox')
    // Same element: nothing unmounted, so nothing remounted — the mount cost is
    // paid once per page load, not per move.
    expect(screen.getByTestId('ui-inbox-panel')).toBe(inboxNode)
  })
})

describe('surface panels: the hidden surface does nothing', () => {
  it('holds no subscription and does not re-render while it is hidden', () => {
    const b = mount({ surface: 'epsilons', resident: true })
    // One listener on the shared source: the VISIBLE surface's. The hidden
    // inbox pane holds none, which is what makes it free.
    expect(b.inbox.counters.live).toBe(1)
    expect(b.channels.counters.live).toBe(0)
    const now = vi.spyOn(Date, 'now')
    const hiddenBefore = screen.getByTestId('ui-surface-inbox').innerHTML
    act(() => {
      b.inbox.proxy.set(inboxState({ rows: [row('delta', { name: 'Delta', lastActivityAt: NOW_SECONDS - 60 })] }))
      b.channels.proxy.set({ rows: [{ id: 'c-1', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }], selected: null, messages: [], error: null, loading: false })
    })
    // InboxPanel reads the clock exactly once per render (the row age line), so
    // a zero here is a render that did not happen — not a render that had
    // nothing to change.
    expect(now).not.toHaveBeenCalled()
    expect(b.inbox.counters.live).toBe(1)
    expect(screen.getByTestId('ui-surface-inbox').innerHTML).toBe(hiddenBefore)
  })

  it('paints what happened while it was hidden the moment it is shown again', () => {
    const b = mount({ surface: 'epsilons', resident: true })
    act(() => {
      b.inbox.proxy.set(inboxState({ rows: [row('delta', { name: 'Delta Renamed' })] }))
    })
    // The hidden pane is frozen on the payload it was last shown with.
    expect(screen.getByTestId('ui-surface-inbox').textContent).toContain('Delta')
    expect(screen.getByTestId('ui-surface-inbox').textContent).not.toContain('Delta Renamed')
    b.show('inbox')
    // Not stale: the first visible render reads the live snapshot.
    expect(screen.getByTestId('ui-surface-inbox').textContent).toContain('Delta Renamed')
    expect(b.inbox.counters.live).toBe(1)
  })

  it('stops listening the instant its surface is hidden', () => {
    const b = mount({ surface: 'inbox', resident: true })
    expect(b.inbox.counters.live).toBe(1)
    b.show('epsilons')
    // The visible EpsilonPanel now owns the one listener; the inbox pane and
    // its channel source are silent.
    expect(b.inbox.counters.live).toBe(1)
    expect(b.channels.counters.live).toBe(0)
    b.show('inbox')
    expect(b.channels.counters.live).toBe(1)
  })
})
