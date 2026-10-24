/**
 * Is this document actually on screen? — the switch that stops a perfectly
 * hidden harness from doing work.
 *
 * Owen, 2026-10-24: the harness is one workspace of an IDE-like page, and an app
 * that is "closed" is "not visible". A visible surface's 2s reads are what make
 * the row states true; the same reads spent on a frame nobody is looking at are
 * the failure mode this ticket exists to avoid ("a paused/stale read is a bug, a
 * busy hidden view is a worse one"). So the pollers ask this, not a clock:
 *
 *   - `document.visibilityState` covers the backgrounded tab;
 *   - an `IntersectionObserver` on the document's root element covers the FRAME
 *     being hidden by the page that embeds it (a `display: none` iframe, another
 *     app on top) — the case a message never announces, because a hidden frame
 *     cannot be asked anything.
 *
 * Default is SHOWN, on purpose: a fresh document, a browser without an observer,
 * and any doubt all read as "on screen", so the failure mode of this module is
 * ordinary polling rather than a workspace that never refreshes again. The signal
 * only ever turns polling off after something has explicitly reported it.
 */

/** The window members this watcher reads; `window` satisfies it. */
export interface ShownWindow {
  /** The document whose visibility is watched. */
  readonly document?: {
    readonly visibilityState?: string
    readonly documentElement?: Element
    addEventListener: (type: 'visibilitychange', listener: () => void) => void
    removeEventListener: (type: 'visibilitychange', listener: () => void) => void
  }
  /** Present in every browser; absent in a bare test stand-in. */
  readonly IntersectionObserver?: typeof IntersectionObserver
}

/** A live on-screen signal: a snapshot read plus a change notification. */
export interface FrameShown {
  /** Whether the document is visible AND its frame is actually intersecting. */
  getSnapshot: () => boolean
  /** Subscribe to changes of that answer. */
  subscribe: (listener: () => void) => () => void
  /** Stop watching (the plugin's effect disposer calls this). */
  dispose: () => void
}

/**
 * Watch whether this document is on screen.
 * @param win - the window to watch; `window` in production.
 * @returns the live signal, plus its disposer.
 */
export function watchFrameShown(win: ShownWindow = globalThis as unknown as ShownWindow): FrameShown {
  const doc = win.document
  let visible = doc?.visibilityState !== 'hidden'
  // Optimistic until an observer says otherwise: see the header.
  let intersecting = true
  let shown = visible
  const listeners = new Set<() => void>()

  const publish = (): void => {
    const next = visible && intersecting
    if (next === shown) return
    shown = next
    for (const listener of listeners) listener()
  }
  const onVisibility = (): void => {
    visible = doc?.visibilityState !== 'hidden'
    publish()
  }
  doc?.addEventListener('visibilitychange', onVisibility)

  const Observer = win.IntersectionObserver
  const root = doc?.documentElement
  const observer = typeof Observer === 'function' && root !== undefined
    ? new Observer((entries) => {
      const entry = entries[entries.length - 1]
      if (entry === undefined) return
      intersecting = entry.isIntersecting
      publish()
    })
    : null
  observer?.observe(root as Element)

  return {
    getSnapshot: () => shown,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose: () => {
      observer?.disconnect()
      doc?.removeEventListener('visibilitychange', onVisibility)
      listeners.clear()
    },
  }
}
