/**
 * Four-column shell frame, registered into the built-in 'root' slot (the web
 * shell renders only 'root'). Owns the grid tracks (sidebar | center |
 * details | right rail), the drag handles (pointer capture + rAF throttle), the
 * concession chain (columns.ts), and the child-slot render decisions: the sidebar slot
 * renders HERE with live parameters from the concession solve, and the
 * session-aware occupants render in fixed column positions; strict entries
 * gate themselves on current-session availability while session-maybe
 * entries retain identity. Pure component: everything arrives
 * through the three framework shares — zero cordis or framework imports,
 * zero self-made hooks.
 *
 * Two geometry contracts, picked by the frame's own shape (columns.ts): a
 * landscape frame runs the concession chain exactly as it always has, while a
 * portrait frame gives the sidebar no grid track at all — the column floats
 * over a chat that keeps its full width, with a dimming scrim behind it when
 * expanded and a transparent rail when collapsed. `data-portrait`,
 * `data-portrait-overlay` and `data-portrait-mobile` are the CSS handles for
 * those states; nothing in the landscape path reads them.
 *
 * The right rail is the fourth track and the inbox column's twin on the far
 * edge. It is not a peer of `details`: `details` is ui-conversation's tool panel
 * (session scope, open on demand), while the rail is persistent shell chrome for
 * a writable conversation, so it gets its own track, its own preference, its own
 * slot and its own position in the concession chain. It renders no compact
 * state — closed means the column is not in the tree, which is also why it needs
 * no `data-rail-collapsed` seam rule.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import {
  computeFrameLayout, isPortrait, SIDEBAR_AUTO_COLLAPSE, SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT,
} from './columns.ts'
import type { createLayoutStore } from './stores.ts'
import { isWritableConversation } from './writable.ts'
import css from './AppFrame.module.css'

/** Full composed props: runtime share + child-slot render share + store share. */
export type AppFrameProps =
  & PropsRuntime<'root'>
  & PropsRenderSlots<'sidebar' | 'conversation' | 'conversation.page' | 'details' | 'rail' | 'shell.overlay'>
  & PropsStore<ReturnType<typeof createLayoutStore>>

/** Center column grid item (session-body building block). */
function CenterColumn(props: { children?: ReactNode }) {
  return <div className={css.centerCol}>{props.children}</div>
}

/** Details column grid item; width 0 keeps the subtree mounted (never unmount on close). */
function DetailsColumn(props: { children?: ReactNode }) {
  return <div className={css.detailsCol}>{props.children}</div>
}

/**
 * Right rail grid item: the inbox column's twin, EMPTY by design this sprint —
 * fill, hairline, accessible name and a stable testid, nothing else. Next
 * sprint's occupant mounts through the 'rail' slot; nothing here invites
 * content, and no placeholder row stands in for it.
 */
function RailColumn(props: { children?: ReactNode }) {
  return (
    <aside className={css.railCol} data-testid="ui-layout-rail" aria-label="Right sidebar">
      {props.children}
    </aside>
  )
}

/**
 * One drag handle: pointer capture, rAF-throttled dx reports against the drag-start origin.
 * `side` keys the hover-reveal CSS to the owning column.
 */
function DragHandle(props: {
  side: 'sidebar' | 'details' | 'rail'
  left: number
  onStart: () => void
  onDrag: (dx: number) => void
  onEnd: () => void
}) {
  const [dragging, setDragging] = useState(false)
  const origin = useRef(0)
  const latest = useRef(0)
  const frame = useRef<number | null>(null)
  const callbacks = useRef({ onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd })
  callbacks.current = { onStart: props.onStart, onDrag: props.onDrag, onEnd: props.onEnd }

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    origin.current = e.clientX
    latest.current = e.clientX
    callbacks.current.onStart()
    setDragging(true)
  }, [])
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    latest.current = e.clientX
    frame.current ??= requestAnimationFrame(() => {
      frame.current = null
      callbacks.current.onDrag(latest.current - origin.current)
    })
  }, [])
  const onPointerUp = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    e.currentTarget.releasePointerCapture(e.pointerId)
    if (frame.current !== null) { cancelAnimationFrame(frame.current); frame.current = null }
    callbacks.current.onDrag(latest.current - origin.current)
    setDragging(false)
    callbacks.current.onEnd()
  }, [])

  return (
    <div
      className={css.handle}
      style={{ left: props.left }}
      data-side={props.side}
      data-dragging={dragging || undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  )
}

/** The four-column frame (see module doc). */
export function AppFrame({
  useStore,
  useSessions,
  actions,
  renderSlot,
}: AppFrameProps) {
  const panels = useStore(s => s)
  const detailsSession = useSessions((s) => {
    const current = s.current
    return current !== undefined && s.byId[current]?.blank === false ? current : undefined
  })
  // The rail's own fact, read from the session list (writable.ts): a read-only
  // transcript — an Epsilon's, or a summary-only one — paints no rail at all.
  const writable = useSessions(isWritableConversation)
  const frameRef = useRef<HTMLDivElement | null>(null)
  const [frame, setFrame] = useState(() => ({ width: window.innerWidth, height: window.innerHeight }))

  const lastSession = useRef(detailsSession)
  useLayoutEffect(() => {
    if (detailsSession === undefined) return
    if (lastSession.current !== undefined && lastSession.current !== detailsSession) {
      actions.closeDetails()
    }
    lastSession.current = detailsSession
  }, [actions, detailsSession])

  // Track the frame's own box (not the window): rAF-throttled ResizeObserver.
  // Both dimensions matter: the shape decides which geometry contract applies.
  useEffect(() => {
    const el = frameRef.current
    /* v8 ignore next -- the ref is always attached by effect time: the frame div renders unconditionally. */
    if (el === null) return
    let raf: number | null = null
    const observer = new ResizeObserver(() => {
      raf ??= requestAnimationFrame(() => {
        raf = null
        const box = el.getBoundingClientRect()
        if (box.width > 0) setFrame({ width: box.width, height: box.height })
      })
    })
    observer.observe(el)
    return () => {
      observer.disconnect()
      if (raf !== null) cancelAnimationFrame(raf)
    }
  }, [])

  // Narrow viewports auto-collapse the sidebar; the store mirror keeps
  // toggleSidebar's semantics right (narrow toggles flip the manual
  // re-expand override, stores.ts). Collapsed is decided here, so the
  // solver stays breakpoint-free: a narrow re-expand passes the preference
  // (or the default when the wide preference is closed) and the center
  // absorbs the squeeze. A portrait frame is always narrow: its default is the
  // rail, and its expanded state floats over the chat instead of squeezing it.
  const portrait = isPortrait(frame.width, frame.height)
  const narrow = portrait || frame.width < SIDEBAR_AUTO_COLLAPSE
  useEffect(() => { actions.setNarrow(narrow) }, [actions, narrow])
  useEffect(() => { actions.setPortrait(portrait) }, [actions, portrait])
  const sidebarCollapsed = narrow ? !panels.narrowExpanded : panels.sidebar === 0
  const sidebarPreference = sidebarCollapsed
    ? 0
    : panels.sidebar === 0 ? SIDEBAR_DEFAULT : panels.sidebar
  // The rail's preference reaches the solve only where the column can legally
  // exist: a writable conversation in a landscape frame. Passing 0 everywhere
  // else means the solver answers 0 without a second breakpoint, and the
  // preference itself is never rewritten (widening, or opening a writable chat,
  // restores it).
  const railPreference = writable && !portrait ? panels.rail : 0
  const layout = computeFrameLayout(
    frame.width,
    frame.height,
    sidebarPreference,
    detailsSession === undefined ? 0 : panels.details,
    railPreference,
  )
  const cols = layout.columns
  // Portrait: the column floats over the chat, so its rendered width is the
  // overlay width (or the rail) rather than a grid track. Landscape keeps the
  // concession solve's own number.
  const sidebarWidth = !portrait
    ? cols.sidebar
    : sidebarCollapsed ? SIDEBAR_COLLAPSED : layout.portrait.width
  // The dimming scrim belongs to the expanded portrait overlay only; the
  // collapsed rail stays transparent over the chat.
  // A closed rail is absent from the tree rather than mounted at zero width: an
  // empty column is pure chrome, so there is no subtree state worth keeping
  // mounted (the details panel keeps DOM; a rail has none).
  const railWidth = cols.rail
  const railOpen = railWidth > 0
  const scrim = portrait && !sidebarCollapsed
  const colsRef = useRef(cols)
  colsRef.current = cols

  // The drag base is the rendered width captured at drag start (grabbing a
  // concession-clamped panel must not jump back to the stored preference);
  // it stays frozen for the whole gesture so dx deltas do not compound.
  const sidebarBase = useRef(0)
  const detailsBase = useRef(0)
  const railBase = useRef(0)
  // Track-level transitions pause for the whole gesture: eased tracks would
  // detach the column edge from the pointer (AppFrame.module.css).
  const [dragging, setDragging] = useState(false)
  const onDragEnd = useCallback(() => { setDragging(false) }, [])
  const onSidebarStart = useCallback(() => { sidebarBase.current = colsRef.current.sidebar; setDragging(true) }, [])
  const onDetailsStart = useCallback(() => { detailsBase.current = colsRef.current.details; setDragging(true) }, [])
  const onRailStart = useCallback(() => { railBase.current = colsRef.current.rail; setDragging(true) }, [])
  const onSidebarDrag = useCallback((dx: number) => {
    actions.setSidebar(sidebarBase.current + dx)
  }, [actions])
  const onDetailsDrag = useCallback((dx: number) => {
    actions.setDetails(detailsBase.current - dx)
  }, [actions])
  // The rail grows leftward, like details: a right-edge column takes the
  // handle's dx with the same sign.
  const onRailDrag = useCallback((dx: number) => {
    actions.setRail(railBase.current - dx)
  }, [actions])

  return (
    <div
      ref={frameRef}
      className={css.frame}
      style={{
        // The rail track exists only while the rail does, so every frame without
        // one keeps the three-track template byte for byte.
        gridTemplateColumns: railOpen
          ? `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px ${railWidth}px`
          : `${cols.sidebar}px minmax(0, 1fr) ${cols.details}px`,
        // The rail inset the portrait chat leaves for the floating column, in
        // both portrait states: one number, so switching states never reflows
        // the conversation's text column.
        ['--ui-frame-rail-width' as string]: `${SIDEBAR_COLLAPSED}px`,
      }}
      data-sidebar-collapsed={sidebarCollapsed || undefined}
      data-details-collapsed={cols.details === 0 || undefined}
      data-dragging={dragging || undefined}
      data-portrait={portrait || undefined}
      data-portrait-overlay={(portrait && !sidebarCollapsed) || undefined}
      data-portrait-mobile={(portrait && layout.portrait.fullscreen) || undefined}
    >
      {/* The dimming scrim sits between the chat and the floating column: it
          darkens the chat the sidebar covers instead of the sidebar squeezing
          it. Painted below the column (z-index in the stylesheet) and inert to
          pointers and assistive tech — the column's own controls close it. */}
      {scrim && <div className={css.scrim} data-testid="ui-layout-scrim" aria-hidden="true" />}
      <div
        className={css.sidebarCol}
        // Portrait sizes the floating column here (its track is 0); landscape
        // takes the track width from the grid.
        style={portrait ? { width: sidebarWidth } : undefined}
      >
        {/* Render-site slot call with live concession output: a closed
            sidebar keeps the mounted slot at the compact-rail width, and the
            component sees its rendered state as owner params decided here
            (collapsed follows the resolved rail, so a derived auto-collapse
            renders the rail UI too). Portrait is the second owner fact: the
            shell drops its opaque fill and floats over the chat. */}
        {renderSlot('sidebar', {
          collapsed: sidebarCollapsed,
          width: sidebarWidth,
          portrait,
        })}
      </div>
      <>
        {/* The column occupants stay at fixed tree positions from first
            paint — no loading gate: a bare status line reads worse than
            the shell's own pending rendering. The conversation
            is session-maybe; the strict details entry naturally renders
            empty while no session is current, and the rail's own (empty)
            column mounts only where a writable conversation asks for it. */}
        <CenterColumn>{panels.page === null
          ? renderSlot('conversation', {})
          : renderSlot('conversation.page', {}, { only: panels.page })}</CenterColumn>
        <DetailsColumn>{renderSlot('details', {})}</DetailsColumn>
        {/* Right rail: last track, so shell chrome holds the frame's outer edge
            while the details panel stays adjacent to the chat it describes. */}
        {railOpen && <RailColumn>{renderSlot('rail', { width: railWidth })}</RailColumn>}
      </>
      <div className={css.overlayLayer} data-shell-overlay>
        {renderSlot('shell.overlay', {})}
      </div>
      {/* The collapsed sidebar keeps its fixed-width rail, so it has no resize
          handle while closed, and a portrait column has no track to drag (it
          floats over the chat). */}
      {!portrait && !sidebarCollapsed && (
        <DragHandle side="sidebar" left={cols.sidebar} onStart={onSidebarStart} onDrag={onSidebarDrag} onEnd={onDragEnd} />
      )}
      {cols.details > 0 && (
        <DragHandle
          side="details"
          left={frame.width - cols.details - railWidth}
          onStart={onDetailsStart}
          onDrag={onDetailsDrag}
          onEnd={onDragEnd}
        />
      )}
      {railOpen && (
        <DragHandle side="rail" left={frame.width - railWidth} onStart={onRailStart} onDrag={onRailDrag} onEnd={onDragEnd} />
      )}
    </div>
  )
}
