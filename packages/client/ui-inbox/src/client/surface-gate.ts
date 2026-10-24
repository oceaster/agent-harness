/**
 * The gate that makes "closed" mean "not visible" instead of "still working".
 *
 * Owen, 2026-10-24: the harness keeps both interfaces mounted and switches what
 * it shows. The failure mode that buys is a hidden panel that keeps updating:
 * every store frame would re-render a surface nobody is looking at, which is
 * MORE work than the page load it replaced, not less. So a surface that is
 * hidden does not subscribe at all — this hook is where that happens.
 *
 * The shape is uSES with a conditional source, and it exists because a slot
 * component's hook is BOUND to its source once, per entry, by the render
 * machinery (`bindInjectHooks` → one `useX` per `hooks` member): a panel cannot
 * decide for itself whether to listen. The occupant can — it renders BOTH
 * panels and knows which one is showing — so it hands each panel a hook built
 * here: live while visible, frozen while hidden.
 *
 * What a frozen surface still does: nothing. No subscription, no store read, no
 * timer, no listener. Its DOM stays exactly as it was left (it is mounted, not
 * unmounted, so a kept surface's own component state — an open row menu, a
 * confirm dialog, the rail's expanded state — survives a trip to the other
 * interface), and the first render after it is shown again reads the live
 * snapshot, so a returning surface paints current data rather than the stale
 * one it was frozen on.
 */
import { useMemo, useRef, useSyncExternalStore } from 'react'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'

/** A bare snapshot source — every store and observable in this stack has this shape. */
export interface SnapshotSource<T> {
  /** The current snapshot. Stable identity between writes. */
  getSnapshot: () => T
  /** Subscribe to writes. */
  subscribe: (listener: () => void) => () => void
}

/** The one subscription a frozen surface holds: none. */
const NO_SUBSCRIPTION = (): (() => void) => () => {}

/**
 * A selector hook over `source` that stops listening while `live` is false.
 *
 * While hidden it returns the snapshot taken when it was last live (its
 * identity does not change, so React re-renders nothing), and while live it
 * behaves like every other hook in this stack: subscribe, select, and compare
 * with the caller's equality (identity by default).
 * @param source - the store the surface reads.
 * @param live - whether the surface is visible right now.
 * @returns the `use<Name>` hook the panel's props expect.
 */
export function useGatedHook<T>(source: SnapshotSource<T>, live: boolean): SnapshotSelectorHook<T> {
  // The value a hidden surface keeps painting: refreshed on every live read and
  // on the way out, never on the way in (the first visible render reads live).
  const frozen = useRef<T | null>(null)
  // Selector results, per the caller's equality, so a selector that builds a
  // new object does not become a new value on every render of this panel. A ref
  // is the same cache `useSyncExternalStoreWithSelector` keeps, and it is what
  // keeps this hook's return identity as stable as the source's.
  const cache = useRef<{ value: unknown } | null>(null)

  const subscribe = useMemo(() => live
    ? (notify: () => void): (() => void) => {
      frozen.current = source.getSnapshot()
      const stop = source.subscribe(() => {
        frozen.current = source.getSnapshot()
        notify()
      })
      // Hide-time snapshot: the store's last word while this surface was
      // still on screen. Read through `getSnapshot`, not through a captured
      // value, so a write that landed without a notification is kept too.
      return () => {
        frozen.current = source.getSnapshot()
        stop()
      }
    }
    : NO_SUBSCRIPTION, [source, live])

  const getSnapshot = useMemo(() => (): T =>
    live ? source.getSnapshot() : (frozen.current ?? source.getSnapshot()), [source, live])

  return function useGated<S>(select: (snapshot: T) => S, equal?: (a: S, b: S) => boolean): S {
    const snapshot = useSyncExternalStore(subscribe, getSnapshot)
    const next = select(snapshot)
    const same = equal ?? Object.is
    if (cache.current !== null && same(cache.current.value as S, next)) return cache.current.value as S
    cache.current = { value: next }
    return next
  }
}
