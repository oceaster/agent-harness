// @vitest-environment jsdom
/**
 * "Is this document on screen?" — the switch that decides whether the harness
 * polls at all.
 *
 * Owen, 2026-10-24: an app that is closed is "not-visible", and a hidden view
 * that keeps working is worse than the page load it replaced. The two ways a
 * harness frame stops being on screen are a backgrounded tab and a frame the
 * embedding page has hidden or covered, so both are watched here — and the
 * answer defaults to SHOWN, because the failure this module must never cause is
 * a workspace that quietly stops refreshing.
 */
import { describe, expect, it, vi } from 'vitest'
import { watchFrameShown, type ShownWindow } from '../src/client/frame-shown.ts'

/** A stand-in window/document pair with a scriptable visibility and observer. */
function bench(options: { visibility?: string; observer?: boolean } = {}) {
  const listeners = new Set<() => void>()
  let visibilityState = options.visibility ?? 'visible'
  const observed: { target: unknown; disconnect: () => void }[] = []
  let report: ((entries: { isIntersecting: boolean }[]) => void) | null = null
  class FakeObserver {
    constructor(callback: (entries: { isIntersecting: boolean }[]) => void) {
      report = callback
      const record = {
        target: undefined as unknown,
        disconnect: vi.fn(),
      }
      observed.push(record)
      this.record = record
    }
    private readonly record: { target: unknown; disconnect: () => void }
    observe(target: Element): void { this.record.target = target }
    disconnect(): void { this.record.disconnect() }
  }
  const documentElement = { tag: 'html' }
  const win = {
    document: {
      get visibilityState() { return visibilityState },
      documentElement: documentElement as unknown as Element,
      addEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.add(listener) },
      removeEventListener: (_type: 'visibilitychange', listener: () => void) => { listeners.delete(listener) },
    },
    ...(options.observer === false ? {} : { IntersectionObserver: FakeObserver as never }),
  }
  const setVisibility = (next: string): void => {
    visibilityState = next
    for (const listener of [...listeners]) listener()
  }
  const intersect = (isIntersecting: boolean): void => { report?.([{ isIntersecting }]) }
  return { win, listeners, observed, setVisibility, intersect }
}

describe('watchFrameShown', () => {
  it('starts shown, and follows the tab going to the background and back', () => {
    const b = bench()
    const shown = watchFrameShown(b.win as unknown as ShownWindow)
    expect(shown.getSnapshot()).toBe(true)
    const notify = vi.fn()
    shown.subscribe(notify)
    b.setVisibility('hidden')
    expect(shown.getSnapshot()).toBe(false)
    expect(notify).toHaveBeenCalledTimes(1)
    // Repeated identical reports cost no notification: the pollers re-arm on
    // this signal, and a spurious one would restart a timer for nothing.
    b.setVisibility('hidden')
    expect(notify).toHaveBeenCalledTimes(1)
    b.setVisibility('visible')
    expect(shown.getSnapshot()).toBe(true)
    expect(notify).toHaveBeenCalledTimes(2)
    shown.dispose()
  })

  it('treats a frame the page has hidden as not on screen', () => {
    const b = bench()
    const shown = watchFrameShown(b.win as unknown as ShownWindow)
    b.intersect(false)
    expect(shown.getSnapshot()).toBe(false)
    b.intersect(true)
    expect(shown.getSnapshot()).toBe(true)
    // An empty batch is not an answer; the last word stands.
    b.intersect(true)
    expect(shown.getSnapshot()).toBe(true)
    shown.dispose()
  })

  it('needs BOTH: a hidden tab whose frame intersects again is still not shown', () => {
    const b = bench()
    const shown = watchFrameShown(b.win as unknown as ShownWindow)
    b.setVisibility('hidden')
    b.intersect(true)
    expect(shown.getSnapshot()).toBe(false)
    b.setVisibility('visible')
    expect(shown.getSnapshot()).toBe(true)
    shown.dispose()
  })

  it('assumes shown when the browser has no observer, rather than never polling', () => {
    const b = bench({ observer: false })
    const shown = watchFrameShown(b.win as unknown as ShownWindow)
    expect(shown.getSnapshot()).toBe(true)
    expect(b.observed).toHaveLength(0)
    b.setVisibility('hidden')
    expect(shown.getSnapshot()).toBe(false)
    shown.dispose()
  })

  it('stops watching when the plugin fiber unloads', () => {
    const b = bench()
    const shown = watchFrameShown(b.win as unknown as ShownWindow)
    const notify = vi.fn()
    shown.subscribe(notify)
    shown.dispose()
    expect(b.listeners.size).toBe(0)
    expect(b.observed[0]?.disconnect).toHaveBeenCalled()
    b.setVisibility('hidden')
    expect(shown.getSnapshot()).toBe(true)
    expect(notify).not.toHaveBeenCalled()
  })
})
