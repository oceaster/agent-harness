// @vitest-environment jsdom
/**
 * AppFrame interaction spec under the four-share props form: real layout
 * store instance (createLayoutStore().create() — the test-sanctioned engine
 * path), a recording renderSlot stub, and a render-prop SessionProvider stub
 * (the real one is framework-wired to the renderer host; its own behavior is
 * ui-renderer's spec territory). Drag sequences (pointer capture + rAF flush),
 * concession response to viewport change, and details staying mounted at
 * zero width are the preserved behavior assertions. jsdom has no layout
 * engine, so the frame width comes from a mocked getBoundingClientRect and
 * resizes are driven through the ResizeObserver stub.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import type { AppFrameProps } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import { SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT } from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import type {
  SessionId, SessionListState, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'

// Session selection controls for the SessionProvider and useSessions stubs.
const selectedSession = { current: 's-test' as SessionId | undefined }
const selectedSessionBlank = { current: false }
// The read-only facts (writable.ts): a subagent summary row, or an addressed
// subagent route. Either one makes the conversation read-only, exactly as
// ConversationRoot's `readOnly = child || childSummary` does.
const selectedSessionOrigin = { current: undefined as 'subagent' | undefined }
const selectedSessionAddress = { current: { parentSessionId: 's-parent', childSessionId: 's-test', mode: 'single' } as object | undefined }
const baselinesReady = { current: true }

// Render-prop contract stub fed through the standard seat prop (the renderer
// injects the real one in production): session mode runs children(id), empty
// mode runs the empty branch — the frame must work against exactly this
// shape. Typed as the seat's own component type so the branded sessionId
// parameter stays contract-checked.
const SessionProviderStub: AppFrameProps['SessionProvider'] = ({ children, empty }) =>
  selectedSession.current === undefined ? <>{empty?.() ?? null}</> : <>{children(selectedSession.current)}</>


/** Observer stub: captures the callback so tests can fire resizes manually. */
let fireResize: (() => void) | null = null
class ResizeObserverStub {
  #cb: ResizeObserverCallback
  constructor(cb: ResizeObserverCallback) { this.#cb = cb }
  observe(): void { fireResize = () => { this.#cb([], this) } }
  unobserve(): void {}
  disconnect(): void { fireResize = null }
}

let frameWidth = 1920
// The frame box is WIDER than it is tall by default: these specs describe the
// landscape concession chain, and portrait is a separate contract with its own
// describe block below. A spec that wants portrait sets both numbers.
let frameHeight = 1080

/** Test-local selector hook over a framework-neutral store instance. */
function hookOf<T>(inst: { subscribe: (fn: () => void) => () => void; getSnapshot: () => T }) {
  return function useSelector<S>(sel: (s: T) => S): S { return sel(useSyncExternalStore(inst.subscribe, inst.getSnapshot)) }
}

function mountFrame() {
  // First-render viewport source before the observer fires.
  window.innerWidth = frameWidth
  window.innerHeight = frameHeight
  const instance = createLayoutStore().create()
  const slotCalls: { key: string; props: unknown }[] = []
  const renderSlot = ((key: string, owner: object) => {
    slotCalls.push({ key, props: owner })
    if (key === 'sidebar') return <div data-testid="sidebar-content" />
    if (key === 'conversation') return <div data-testid="center-content" />
    if (key === 'conversation.page') return <div data-testid="channel-content" />
    if (key === 'details') return <div data-testid="details-content" />
    if (key === 'rail') return null
    if (key === 'conversation.empty') return <div data-testid="empty-content" />
    return <div data-testid="other-content" />
  }) as AppFrameProps['renderSlot']
  const useSessions = ((sel: (s: SessionListState) => unknown) => {
    const current = selectedSession.current
    const sessionState = {
      ids: current === undefined ? [] : [current],
      byId: current === undefined
        ? {}
        : {
          [current]: {
            id: current,
            displayTitle: 'Test',
            running: false,
            blank: selectedSessionBlank.current,
            updatedAt: 1,
            ...(selectedSessionOrigin.current === undefined ? {} : { origin: selectedSessionOrigin.current }),
          },
        },
      current,
      phase: 'ready',
      currentAddress: selectedSessionAddress.current,
    } as SessionListState
    return sel(sessionState)
  }) as never
  const workspaceState: WorkspaceListState = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: baselinesReady.current, recentWorkspaceId: undefined,
  }
  const element = () => (
    <AppFrame
      useStore={hookOf(instance)}
      actions={instance.actions}
      renderSlot={renderSlot}
      useSessions={useSessions}
      useWorkspaces={((sel: (s: WorkspaceListState) => unknown) => sel(workspaceState)) as never}
      SessionProvider={SessionProviderStub}
    />
  )
  const utils = render(element())
  const frame = utils.container.firstElementChild as HTMLElement
  return { instance, frame, slotCalls, rerenderFrame: () => { utils.rerender(element()) }, ...utils }
}

// The template is three tracks, plus the rail track when the rail exists.
const TEMPLATE = /^(\d+)px minmax\(0, 1fr\) (\d+)px(?: (\d+)px)?$/

/**
 * The sidebar and details tracks. The center track is `minmax(0, 1fr)`, which
 * jsdom cannot resolve, so the measured center comes from centerTrack below.
 * @param frame - the frame element.
 * @returns sidebar px and details px.
 */
function tracks(frame: HTMLElement): number[] {
  const m = TEMPLATE.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return [Number(m[1]), Number(m[2])]
}

/**
 * The right rail track: absent (0) whenever the rail is not painted.
 * @param frame - the frame element.
 * @returns rail px, or 0 for a frame with no rail track.
 */
function railTrack(frame: HTMLElement): number {
  const m = TEMPLATE.exec(frame.style.gridTemplateColumns)
  if (m === null) throw new Error(`unexpected template: ${frame.style.gridTemplateColumns}`)
  return m[3] === undefined ? 0 : Number(m[3])
}

/**
 * The center track as the browser must resolve it: the frame width the stubbed
 * getBoundingClientRect reports, minus every fixed track. A negative or missing
 * number means the tracks do not fit, i.e. horizontal overflow.
 * @param frame - the frame element.
 * @returns the center column width in px.
 */
function centerTrack(frame: HTMLElement): number {
  return frameWidth - tracks(frame)[0]! - tracks(frame)[1]! - railTrack(frame)
}

function drag(handle: Element, fromX: number, toX: number): void {
  const down = new PointerEvent('pointerdown', { pointerId: 1, clientX: fromX, bubbles: true })
  const move = new PointerEvent('pointermove', { pointerId: 1, clientX: toX, bubbles: true })
  const up = new PointerEvent('pointerup', { pointerId: 1, clientX: toX, bubbles: true })
  act(() => { handle.dispatchEvent(down) })
  act(() => { handle.dispatchEvent(move); vi.advanceTimersByTime(20) })
  act(() => { handle.dispatchEvent(up) })
}

beforeEach(() => {
  // The panel widths are durable now (dsh.layout.panels), so each test starts
  // from empty storage instead of inheriting the previous test's drag.
  localStorage.clear()
  frameWidth = 1920
  frameHeight = 1080
  selectedSession.current = 's-test' as SessionId
  selectedSessionBlank.current = false
  selectedSessionOrigin.current = undefined
  selectedSessionAddress.current = undefined
  baselinesReady.current = true
  vi.useFakeTimers()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => { cb(0) }, 16) as unknown as number)
  vi.stubGlobal('cancelAnimationFrame', (h: number) => { clearTimeout(h) })
  window.innerWidth = frameWidth
  window.innerHeight = frameHeight
  Element.prototype.getBoundingClientRect = function () {
    return {
      width: frameWidth, height: frameHeight, top: 0, left: 0,
      right: frameWidth, bottom: frameHeight, x: 0, y: 0, toJSON: () => ({}),
    }
  }
  // jsdom lacks pointer capture: emulate per-element so hasPointerCapture gates pass.
  const captured = new WeakSet<Element>()
  Element.prototype.setPointerCapture = function () { captured.add(this) }
  Element.prototype.releasePointerCapture = function () { captured.delete(this) }
  Element.prototype.hasPointerCapture = function () { return captured.has(this) }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('AppFrame', () => {
  it('shows a selected page in the center tile and restores the conversation on return', () => {
    const b = mountFrame()
    expect(b.queryByTestId('center-content')).not.toBeNull()
    act(() => { b.instance.actions.openPage('agent-channel') })
    expect(b.queryByTestId('center-content')).toBeNull()
    expect(b.queryByTestId('channel-content')).not.toBeNull()
    expect(b.queryByTestId('sidebar-content')).not.toBeNull()
    act(() => { b.instance.actions.openPage(null) })
    expect(b.queryByTestId('channel-content')).toBeNull()
    expect(b.queryByTestId('center-content')).not.toBeNull()
  })

  it('renders three tracks from store state', () => {
    const { frame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('renders the session pair with empty owner shares (sessionId is framework-standard)', () => {
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(getByTestId('details-content')).toBeTruthy()
    const keys = slotCalls.map(c => c.key)
    expect(keys).toContain('conversation')
    expect(keys).toContain('details')
    expect(keys).not.toContain('conversation.empty')
    expect(slotCalls.find(c => c.key === 'conversation')!.props).toEqual({})
    expect(slotCalls.find(c => c.key === 'details')!.props).toEqual({})
  })

  it('keeps the conversation slot mounted while no session is current', () => {
    // No current session: the session-maybe conversation shell owns the New
    // Session view itself — the center column renders it unconditionally.
    selectedSession.current = undefined
    const { slotCalls, getByTestId } = mountFrame()
    expect(getByTestId('center-content')).toBeTruthy()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
  })

  it('renders both column occupants before baselines settle (no loading gate)', () => {
    // No loading gate: a bare loading status reads worse than the shell's own
    // pending rendering — both occupants mount from first paint.
    baselinesReady.current = false
    const { slotCalls } = mountFrame()
    expect(slotCalls.map(c => c.key)).toContain('conversation')
    expect(slotCalls.map(c => c.key)).toContain('details')
  })

  it('ignores unselected states and closes only when the Session id changes', () => {
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = 's-next' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])

    act(() => { instance.actions.openDetails() })
    selectedSession.current = 's-blank' as SessionId
    selectedSessionBlank.current = true
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(360)

    selectedSession.current = 's-next' as SessionId
    selectedSessionBlank.current = false
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 360])

    selectedSession.current = undefined
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
    selectedSession.current = 's-test' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('keeps details closed when the first Session materializes', () => {
    selectedSession.current = undefined
    const { frame, instance, rerenderFrame } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().details).toBe(0)

    selectedSession.current = 's-first' as SessionId
    act(() => { rerenderFrame() })
    expect(tracks(frame)).toEqual([280, 0])
  })

  it('sidebar slot receives live concession output as owner props', () => {
    const { slotCalls } = mountFrame()
    expect(slotCalls.find(c => c.key === 'sidebar')!.props).toEqual({ collapsed: false, width: 280, portrait: false })
  })

  it('sidebar drag widens through rAF-batched pointer moves', () => {
    const { frame } = mountFrame()
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[0]!, 280, 350)
    expect(tracks(frame)[0]).toBe(350)
  })

  it('details drag widens leftward (negative dx grows the panel)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 1560, 1500)
    expect(tracks(frame)[1]).toBe(420)
  })

  it('drag base is the rendered (concession-clamped) width, not the preference', () => {
    frameWidth = 1250 // step-2 squeeze: details renders 330 while preference is 360
    frameHeight = 800
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 330])
    const handles = frame.querySelectorAll('[class*="handle"]')
    drag(handles[1]!, 920, 930) // shrink by 10 from the rendered width
    expect(instance.getSnapshot().details).toBe(320)
  })

  it('details column stays mounted at zero width', () => {
    const { frame, getByTestId } = mountFrame()
    expect(tracks(frame)).toEqual([280, 0])
    expect(getByTestId('details-content')).toBeTruthy()
    expect(frame.hasAttribute('data-details-collapsed')).toBe(true)
  })

  it('closed sidebar keeps its compact rail with mounted slot content and collapsed owner props', () => {
    const { frame, instance, slotCalls, getByTestId } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(getByTestId('sidebar-content')).toBeTruthy()
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    const lastSidebarCall = slotCalls.filter(c => c.key === 'sidebar').at(-1)!
    expect(lastSidebarCall.props).toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED, portrait: false })
  })

  it('viewport shrink triggers the concession chain via ResizeObserver', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 360])
  })

  it('drag handles disappear for collapsed columns', () => {
    // Every open, resizable column owns one handle: sidebar, details, rail. The
    // rail is open by default in a writable conversation, so the baseline is 2.
    const { frame, instance } = mountFrame()
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.openDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(3)
    act(() => { instance.actions.closeDetails() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(2)
    act(() => { instance.actions.closeRail() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
  })
})

describe('AppFrame — narrow-viewport auto-collapse', () => {
  it('mounts collapsed below the breakpoint with no sidebar handle', () => {
    frameWidth = 980
    frameHeight = 800
    const { frame, slotCalls } = mountFrame()
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props)
      .toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED, portrait: false })
    // 980 still fits a 56px rail sidebar, CENTER_MIN and a 280px right rail, so
    // the only handle left is the right rail's own.
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    expect((frame.querySelectorAll('[class*="handle"]')[0] as HTMLElement).getAttribute('data-side')).toBe('rail')
  })

  it('narrow toggle re-expands over the squeezed center and back', () => {
    frameWidth = 980
    frameHeight = 800
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(1)
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
  })

  it('a wide-closed preference re-expands at the contract default while narrow', () => {
    frameWidth = 1920
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() }) // close while wide: preference 0
    frameWidth = 980
    frameHeight = 800
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    act(() => { instance.actions.toggleSidebar() })
    expect(tracks(frame)).toEqual([280, 0])
    expect(instance.getSnapshot().sidebar).toBe(0) // preference untouched
  })

  it('shrinking across the breakpoint auto-collapses; re-widening restores the drag width', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.setSidebar(400) })
    frameWidth = 980
    frameHeight = 800
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([SIDEBAR_COLLAPSED, 0])
    frameWidth = 1920
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([400, 0])
  })
})

describe('AppFrame — guard branches', () => {
  it('pointer moves without capture are ignored (no width write)', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    const before = instance.getSnapshot().sidebar
    // Move + up without a preceding pointerdown: hasPointerCapture is false.
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 9, clientX: 500, bubbles: true }))
      vi.advanceTimersByTime(20)
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: 500, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(before)
  })

  it('two moves inside one frame coalesce through the pending rAF', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      // Two moves before the frame flushes: the second must ride the pending
      // rAF (frame.current ??= guard), and the flush sees the latest x.
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 320, bubbles: true }))
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 340, bubbles: true }))
      vi.advanceTimersByTime(20)
    })
    act(() => { handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 340, bubbles: true })) })
    expect(instance.getSnapshot().sidebar).toBe(340)
  })

  it('pointerup with a pending rAF cancels it and commits the final position', () => {
    const { frame, instance } = mountFrame()
    const handle = frame.querySelectorAll('[class*="handle"]')[0]!
    act(() => { handle.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, clientX: 280, bubbles: true })) })
    act(() => {
      handle.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 360, bubbles: true }))
      // No timer advance: the rAF is still pending when pointerup arrives.
      handle.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 360, bubbles: true }))
    })
    expect(instance.getSnapshot().sidebar).toBe(360)
  })

  it('zero-width resize reports are ignored (display:none window)', () => {
    const { frame } = mountFrame()
    frameWidth = 0
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    // Track template still reflects the last non-zero viewport.
    expect(tracks(frame)).toEqual([280, 0])
  })
})

describe('AppFrame — unmount with an in-flight resize frame', () => {
  it('cancels the pending rAF on unmount (no post-unmount setState)', () => {
    const { unmount } = mountFrame()
    frameWidth = 800
    frameHeight = 600
    act(() => { fireResize?.() }) // rAF scheduled, NOT flushed
    unmount()
    // Flushing after unmount must be a no-op (the frame was cancelled).
    expect(() => { vi.advanceTimersByTime(20) }).not.toThrow()
  })

  it('double resize inside one frame rides the pending rAF (??= guard)', () => {
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.openDetails() })
    frameWidth = 1250
    act(() => { fireResize?.(); fireResize?.(); vi.advanceTimersByTime(20) })
    expect(tracks(frame)).toEqual([280, 330])
  })
})

describe('AppFrame — right rail', () => {
  const rail = (frame: HTMLElement): HTMLElement | null => frame.querySelector('[data-testid="ui-layout-rail"]')

  it('mounts an empty rail in a writable conversation', () => {
    const { frame, slotCalls } = mountFrame()
    const column = rail(frame)
    expect(column).not.toBeNull()
    // A real track, at the rail's own width, beside the details track.
    expect(railTrack(frame)).toBe(280)
    expect(frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px 280px')
    // The occupant seat is rendered with the live width and paints nothing.
    expect(slotCalls.filter(c => c.key === 'rail').at(-1)!.props).toEqual({ width: 280 })
    // EMPTY MEANS EMPTY: no children, no text, no placeholder.
    expect(column!.childElementCount).toBe(0)
    expect(column!.textContent).toBe('')
    // An accessible name, and the twin's own shape (the element is a landmark).
    expect(column!.tagName).toBe('ASIDE')
    expect(column!.getAttribute('aria-label')).toBe('Right sidebar')
  })

  it('does not mount for a read-only (Epsilon) transcript', () => {
    // ConversationRoot's `readOnly = child || childSummary`, read the way a
    // root-scope frame can read it: a subagent summary row...
    selectedSessionOrigin.current = 'subagent'
    const byRow = mountFrame()
    expect(rail(byRow.frame)).toBeNull()
    expect(railTrack(byRow.frame)).toBe(0)
    expect(byRow.slotCalls.map(c => c.key)).not.toContain('rail')
    expect(byRow.frame.style.gridTemplateColumns).toBe('280px minmax(0, 1fr) 0px')
    cleanup()

    // ...or an addressed subagent route (the session's own `subagent` record).
    selectedSessionOrigin.current = undefined
    selectedSessionAddress.current = { parentSessionId: 's-parent', childSessionId: 's-test', mode: 'single' }
    const byRoute = mountFrame()
    expect(rail(byRoute.frame)).toBeNull()
    expect(byRoute.slotCalls.map(c => c.key)).not.toContain('rail')
  })

  it('does not mount with no conversation at all', () => {
    selectedSession.current = undefined
    const { frame, slotCalls } = mountFrame()
    expect(rail(frame)).toBeNull()
    expect(slotCalls.map(c => c.key)).not.toContain('rail')
  })

  it('measures the center column at 1440 with the rail open and closed', () => {
    frameWidth = 1440
    frameHeight = 900
    const open = mountFrame()
    // REPORTED: 880 with the rail open (280 sidebar + 280 rail + 1fr center).
    expect(tracks(open.frame)).toEqual([280, 0])
    expect(railTrack(open.frame)).toBe(280)
    expect(centerTrack(open.frame)).toBe(880)
    cleanup()

    act(() => { /* the rail is closed through the service face, not a preference write */ })
    const closed = mountFrame()
    act(() => { closed.instance.actions.closeRail() })
    expect(rail(closed.frame)).toBeNull()
    // REPORTED: 1160 with the rail closed — the rail costs exactly 280.
    expect(centerTrack(closed.frame)).toBe(1160)
    expect(centerTrack(closed.frame) - 880).toBe(280)
  })

  it('never paints the rail in portrait, so a 390px chat cannot overflow', () => {
    frameWidth = 390
    frameHeight = 844
    const { frame, instance, slotCalls } = mountFrame()
    expect(frame.hasAttribute('data-portrait')).toBe(true)
    expect(rail(frame)).toBeNull()
    expect(slotCalls.map(c => c.key)).not.toContain('rail')
    expect(frame.style.gridTemplateColumns).toBe('0px minmax(0, 1fr) 0px')
    // No track sum above the viewport: nothing to scroll horizontally.
    expect(tracks(frame)[0]! + tracks(frame)[1]! + railTrack(frame)).toBe(0)
    expect(centerTrack(frame)).toBe(390)
    // Rotating back to a landscape frame brings the rail back with its width.
    frameWidth = 1440
    frameHeight = 900
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(railTrack(frame)).toBe(280)
    expect(instance.getSnapshot().rail).toBe(280)
  })

  it('leaves no border state behind when the rail is closed', () => {
    // The details column stays mounted at zero width and needs
    // `.frame[data-details-collapsed] .detailsCol { border-left: none }`. The
    // rail has no such seam because a closed rail is absent from the tree.
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.closeRail() })
    expect(rail(frame)).toBeNull()
    expect(frame.querySelector('[class*="railCol"]')).toBeNull()
    expect(railTrack(frame)).toBe(0)
    // Closing the rail is not closing details: the details state is untouched.
    expect(instance.getSnapshot().rail).toBe(0)
    expect(instance.getSnapshot().details).toBe(0)
    act(() => { instance.actions.openDetails() })
    expect(tracks(frame)).toEqual([280, 360])
    expect(rail(frame)).toBeNull()
  })

  it('auto-closes the rail on a narrow viewport through the concession chain', () => {
    frameWidth = 1440
    frameHeight = 900
    const { frame } = mountFrame()
    expect(railTrack(frame)).toBe(280)
    // 1100 landscape: 280 sidebar + 280 rail + CENTER_MIN is 1200, and the rail's
    // own floor cannot rescue it, so the rail is the column the chain drops —
    // no breakpoint in the frame decided that.
    frameWidth = 1100
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(rail(frame)).toBeNull()
    expect(railTrack(frame)).toBe(0)
    expect(centerTrack(frame)).toBe(820)
  })

  it('re-widening restores the rail without a preference rewrite', () => {
    frameWidth = 1100
    frameHeight = 900
    const { frame, instance } = mountFrame()
    expect(rail(frame)).toBeNull()
    expect(instance.getSnapshot().rail).toBe(280)
    frameWidth = 1440
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(railTrack(frame)).toBe(280)
    expect(rail(frame)).not.toBeNull()
  })

  it('resizes by its own handle, and the details handle moves with it', () => {
    const { frame, instance } = mountFrame()
    // Handles: sidebar, then rail (details is closed).
    const handles = frame.querySelectorAll('[class*="handle"]')
    expect(handles).toHaveLength(2)
    expect((handles[1] as HTMLElement).getAttribute('data-side')).toBe('rail')
    // The rail's handle sits on the rail's outer-turned inner edge.
    expect((handles[1] as HTMLElement).style.left).toBe(`${frameWidth - 280}px`)
    drag(handles[1]!, 1640, 1580) // drag left: the rail grows
    expect(railTrack(frame)).toBe(340)
    expect(instance.getSnapshot().rail).toBe(340)
    // With details open too, the details handle sits left of the rail track.
    act(() => { instance.actions.openDetails() })
    const both = frame.querySelectorAll('[class*="handle"]')
    expect(both).toHaveLength(3)
    expect((both[1] as HTMLElement).getAttribute('data-side')).toBe('details')
    expect((both[1] as HTMLElement).style.left).toBe(`${frameWidth - 360 - 340}px`)
  })
})

describe('AppFrame — portrait overlay', () => {
  /** Put the frame in portrait: 800x1200 is the desktop-portrait reference case. */
  function mountPortrait(width = 800, height = 1200) {
    frameWidth = width
    frameHeight = height
    return mountFrame()
  }

  const scrim = (frame: HTMLElement): HTMLElement | null => frame.querySelector('[data-testid="ui-layout-scrim"]')

  it('gives the chat the whole frame width and no sidebar track', () => {
    const { frame } = mountPortrait()
    expect(tracks(frame)).toEqual([0, 0])
    expect(frame.style.gridTemplateColumns).toBe('0px minmax(0, 1fr) 0px')
    expect(frame.hasAttribute('data-portrait')).toBe(true)
    // Collapsed by default, like the narrow frame it already was.
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.hasAttribute('data-portrait-overlay')).toBe(false)
    expect(scrim(frame)).toBeNull()
  })

  it('floats the collapsed rail at its own width with no resize handle', () => {
    const { frame, slotCalls } = mountPortrait()
    const column = frame.querySelector('[class*="sidebarCol"]') as HTMLElement
    expect(column.style.width).toBe(`${SIDEBAR_COLLAPSED}px`)
    expect(frame.querySelectorAll('[class*="handle"]')).toHaveLength(0)
    expect(slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props)
      .toEqual({ collapsed: true, width: SIDEBAR_COLLAPSED, portrait: true })
  })

  it('the chat column width is identical collapsed and expanded, and expansion paints a scrim', () => {
    const { frame, instance, slotCalls } = mountPortrait()
    const columnOf = (): HTMLElement => frame.querySelector('[class*="centerCol"]') as HTMLElement
    const collapsedWidth = frame.style.gridTemplateColumns
    const collapsedColumn = columnOf().className

    act(() => { instance.actions.toggleSidebar() })
    expect(frame.hasAttribute('data-portrait-overlay')).toBe(true)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
    // The chat keeps the width it would have had: no track moved.
    expect(frame.style.gridTemplateColumns).toBe(collapsedWidth)
    expect(columnOf().className).toBe(collapsedColumn)
    // The floating column takes the widened portrait width, not a track.
    const sidebar = slotCalls.filter(c => c.key === 'sidebar').at(-1)!.props as { width: number; portrait: boolean }
    expect(sidebar).toEqual({ collapsed: false, width: 496, portrait: true })
    expect((frame.querySelector('[class*="sidebarCol"]') as HTMLElement).style.width).toBe('496px')
    // Expanded paints the dimming scrim behind the panel.
    expect(scrim(frame)).not.toBeNull()
    expect(scrim(frame)!.getAttribute('aria-hidden')).toBe('true')
  })

  it('a mobile portrait frame marks the panel as a full-frame menu', () => {
    const { frame, instance } = mountPortrait(390, 844)
    expect(frame.hasAttribute('data-portrait-mobile')).toBe(true)
    act(() => { instance.actions.toggleSidebar() })
    expect((frame.querySelector('[class*="sidebarCol"]') as HTMLElement).style.width).toBe('390px')
    expect(scrim(frame)).not.toBeNull()
  })

  it('crossing into portrait from landscape drops a narrow-landscape manual expand', () => {
    // 980x800 is landscape-narrow; expanding it is a manual override.
    frameWidth = 980
    frameHeight = 800
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.toggleSidebar() })
    expect(instance.getSnapshot().narrowExpanded).toBe(true)
    // Rotate: the frame becomes portrait and the override is dropped, so the
    // overlay starts collapsed instead of covering the chat unasked.
    frameWidth = 800
    frameHeight = 1200
    act(() => { fireResize?.(); vi.advanceTimersByTime(20) })
    expect(frame.hasAttribute('data-portrait')).toBe(true)
    expect(instance.getSnapshot().portrait).toBe(true)
    expect(instance.getSnapshot().narrowExpanded).toBe(false)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
  })

  it('collapses on a selection event in portrait, and only then', () => {
    const { frame, instance } = mountPortrait()
    act(() => { instance.actions.toggleSidebar() }) // manual expand
    expect(frame.hasAttribute('data-portrait-overlay')).toBe(true)
    // A render — any render — is not a selection: there is no effect that
    // collapses here, so the override survives the re-render below.
    act(() => { instance.actions.setDetails(360) })
    act(() => { instance.actions.closeDetails() })
    expect(frame.hasAttribute('data-portrait-overlay')).toBe(true)
    act(() => { instance.actions.collapseOnSelection() })
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(true)
    expect(frame.hasAttribute('data-portrait-overlay')).toBe(false)
    expect(scrim(frame)).toBeNull()
  })

  it('a landscape frame ignores the selection collapse', () => {
    frameWidth = 1920
    frameHeight = 1080
    const { frame, instance } = mountFrame()
    act(() => { instance.actions.collapseOnSelection() })
    // Landscape keeps its open column: the preference is untouched and the
    // override is not a landscape concept.
    expect(instance.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
    expect(frame.hasAttribute('data-sidebar-collapsed')).toBe(false)
  })
})
