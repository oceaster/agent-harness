/**
 * LayoutController behavior: the cross-plugin panel-action face. Geometry
 * lives in the entry store (layout-store.spec.ts) — here we assert the
 * delegation contract: attachPanels wiring, the three actions forwarding, the
 * unwired fail-loud for gestures, the page request held until the frame mounts,
 * and re-attach overwriting a stale action set.
 */
import { describe, expect, it, vi } from 'vitest'
import { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'
import type { PanelActions } from '@deepseek-ai/dsh-client-ui-layout/src/client/service.ts'

function fakePanels(): PanelActions {
  return {
    setSidebar: vi.fn(),
    setDetails: vi.fn(),
    toggleSidebar: vi.fn(),
    setNarrow: vi.fn(),
    setPortrait: vi.fn(),
    collapseOnSelection: vi.fn(),
    openDetails: vi.fn(),
    closeDetails: vi.fn(),
    openPage: vi.fn(),
  }
}

describe('LayoutController', () => {
  it('forwards the three panel actions to the attached set', () => {
    const service = new LayoutController()
    const panels = fakePanels()
    service.attachPanels(panels)

    service.toggleSidebar()
    service.openDetails()
    service.closeDetails()

    expect(panels.toggleSidebar).toHaveBeenCalledTimes(1)
    expect(panels.openDetails).toHaveBeenCalledTimes(1)
    expect(panels.closeDetails).toHaveBeenCalledTimes(1)
    expect(panels.setSidebar).not.toHaveBeenCalled()
    expect(panels.setDetails).not.toHaveBeenCalled()
  })

  it('fails loud before the root entry wired its actions', () => {
    const service = new LayoutController()
    expect(() => { service.toggleSidebar() }).toThrow(/panel actions not wired/)
    expect(() => { service.openDetails() }).toThrow(/panel actions not wired/)
    expect(() => { service.closeDetails() }).toThrow(/panel actions not wired/)
  })

  it('holds a page requested before the frame mounted and applies it at attach', () => {
    // The channel restore runs at boot, as soon as the server answers the
    // channel list, which can precede the root entry's first render. The
    // request is intent, so it waits for the wiring instead of throwing into a
    // fire-and-forget promise nobody observes.
    const service = new LayoutController()
    const panels = fakePanels()

    service.openPage('agent-channel')
    expect(panels.openPage).not.toHaveBeenCalled()

    service.attachPanels(panels)
    expect(panels.openPage).toHaveBeenCalledWith('agent-channel')

    // Consumed once: a later re-attach does not replay it.
    const fresh = fakePanels()
    service.attachPanels(fresh)
    expect(fresh.openPage).not.toHaveBeenCalled()

    // And a mounted face forwards immediately, the way a click does.
    service.openPage(null)
    expect(fresh.openPage).toHaveBeenCalledWith(null)
  })

  it('re-attach overwrites the stale action set (entry re-register)', () => {
    const service = new LayoutController()
    const stale = fakePanels()
    const fresh = fakePanels()
    service.attachPanels(stale)
    service.attachPanels(fresh)

    service.toggleSidebar()

    expect(stale.toggleSidebar).not.toHaveBeenCalled()
    expect(fresh.toggleSidebar).toHaveBeenCalledTimes(1)
  })
})
