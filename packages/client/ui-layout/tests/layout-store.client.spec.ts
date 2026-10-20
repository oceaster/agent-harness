// @vitest-environment jsdom
/**
 * createLayoutStore unit account: init shape, the action write set (clamp
 * inside actions), and the absence of browser persistence. Uses the
 * test-sanctioned path: factory self-call + .create() gives the
 * real engine instance (same create path as production).
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { createLayoutStore } from '@deepseek-ai/dsh-client-ui-layout/src/client/stores.ts'
import {
  DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

const PERSIST_KEY = 'dsh.layout.panels'

beforeEach(() => { localStorage.clear() })

describe('createLayoutStore', () => {
  it('initializes the sidebar at its default width, details closed, wide viewport assumed', () => {
    const { store } = createLayoutStore().create()
    expect(store.getSnapshot()).toEqual({
      sidebar: SIDEBAR_DEFAULT, details: 0, narrow: false, narrowExpanded: false, portrait: false, page: null,
    })
  })

  it('each create() is an independent instance (factory is not a singleton)', () => {
    const a = createLayoutStore().create()
    const b = createLayoutStore().create()
    a.actions.setSidebar(400)
    expect(b.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('setSidebar/setDetails clamp into the contract ranges', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(1)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MIN)
    actions.setSidebar(9999)
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_MAX)
    actions.setDetails(1)
    expect(store.getSnapshot().details).toBe(DETAILS_MIN)
    actions.setDetails(9999)
    expect(store.getSnapshot().details).toBe(DETAILS_MAX)
  })

  it('toggleSidebar flips closed <-> contract default (drag width forgotten)', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(0)
    actions.toggleSidebar()
    expect(store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
  })

  it('narrow toggleSidebar flips only the re-expand override; the width preference survives', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setSidebar(400)
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot()).toEqual({
      sidebar: 400, details: 0, narrow: true, narrowExpanded: true, portrait: false, page: null,
    })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(false)
    expect(store.getSnapshot().sidebar).toBe(400)
  })

  it('crossing the breakpoint drops the override; a same-value setNarrow keeps it', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setNarrow(false)
    expect(store.getSnapshot()).toMatchObject({ narrow: false, narrowExpanded: false })
    actions.setNarrow(true)
    expect(store.getSnapshot().narrowExpanded).toBe(false)
  })

  it('setPortrait records the shape and drops a stale re-expand override', () => {
    const { store, actions } = createLayoutStore().create()
    actions.setNarrow(true)
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setPortrait(true)
    expect(store.getSnapshot()).toMatchObject({ portrait: true, narrowExpanded: false })
    actions.toggleSidebar()
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setPortrait(true) // same value: no write, override kept
    expect(store.getSnapshot().narrowExpanded).toBe(true)
    actions.setPortrait(false)
    expect(store.getSnapshot()).toMatchObject({ portrait: false, narrowExpanded: false })
  })

  it('collapseOnSelection collapses a portrait frame and never touches a landscape one', () => {
    const portrait = createLayoutStore().create()
    portrait.actions.setNarrow(true)
    portrait.actions.setPortrait(true)
    portrait.actions.setSidebar(400)
    portrait.actions.toggleSidebar() // manual expand
    expect(portrait.store.getSnapshot().narrowExpanded).toBe(true)
    portrait.actions.collapseOnSelection()
    expect(portrait.store.getSnapshot().narrowExpanded).toBe(false)
    // The width preference is not the collapse target: it survives untouched.
    expect(portrait.store.getSnapshot().sidebar).toBe(400)

    const landscape = createLayoutStore().create()
    landscape.actions.setSidebar(400)
    landscape.actions.collapseOnSelection()
    expect(landscape.store.getSnapshot()).toMatchObject({ sidebar: 400, narrow: false, narrowExpanded: false })

    const narrowLandscape = createLayoutStore().create()
    narrowLandscape.actions.setNarrow(true)
    narrowLandscape.actions.toggleSidebar()
    expect(narrowLandscape.store.getSnapshot().narrowExpanded).toBe(true)
    narrowLandscape.actions.collapseOnSelection()
    // Landscape keeps its manual re-expand: the rule is portrait-only.
    expect(narrowLandscape.store.getSnapshot().narrowExpanded).toBe(true)
  })

  it('openDetails uses the contract default, preserves an open width, and closeDetails zeroes', () => {
    const { store, actions } = createLayoutStore().create()
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(DETAILS_DEFAULT)
    actions.setDetails(500)
    actions.openDetails()
    expect(store.getSnapshot().details).toBe(500)
    actions.closeDetails()
    expect(store.getSnapshot().details).toBe(0)
  })

  it('persists exactly the two panel widths, under the dsh prefix', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    first.actions.openDetails()
    first.actions.setDetails(500)
    expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({ sidebar: 400, details: 500 })
  })

  it('restores sidebar width, details width and whether details is open', () => {
    createLayoutStore().create().actions.setSidebar(400)
    const reopened = createLayoutStore().create()
    expect(reopened.store.getSnapshot()).toMatchObject({ sidebar: 400, details: 0 })
    reopened.actions.openDetails()
    reopened.actions.setDetails(500)
    const reloaded = createLayoutStore().create()
    expect(reloaded.store.getSnapshot()).toMatchObject({ sidebar: 400, details: 500 })
    // A closed details panel is a stored 0 too, not a missing key.
    reloaded.actions.closeDetails()
    expect(createLayoutStore().create().store.getSnapshot().details).toBe(0)
  })

  it('never persists the viewport-derived fields or the selected page', () => {
    const first = createLayoutStore().create()
    first.actions.setSidebar(400)
    // Shape first, then breakpoint: each setter drops the manual override, so
    // the expand below is the last word (that ordering is the store's own rule).
    first.actions.setPortrait(true)
    first.actions.setNarrow(true)
    first.actions.toggleSidebar()      // narrowExpanded = true
    first.actions.openPage('agent-channel')
    expect(first.store.getSnapshot()).toMatchObject({
      narrow: true, narrowExpanded: true, portrait: true, page: 'agent-channel',
    })
    // The stored subset is the widths and nothing else: replaying a viewport
    // reading would fight AppFrame's own measurement, and the page has a single
    // writer (ui-inbox), so layout must not persist it.
    const stored = JSON.parse(localStorage.getItem(PERSIST_KEY)!) as Record<string, number>
    expect(Object.keys(stored).sort()).toEqual(['details', 'sidebar'])
    const second = createLayoutStore().create()
    expect(second.store.getSnapshot()).toEqual({
      sidebar: 400,
      details: 0,
      narrow: false,
      narrowExpanded: false,
      portrait: false,
      page: null,
    })
  })

  it('keeps unrelated stored keys out of the state and falls back on a corrupt entry', () => {
    localStorage.setItem(PERSIST_KEY, '{"sidebar":420,"details":0}')
    expect(createLayoutStore().create().store.getSnapshot().sidebar).toBe(420)
    localStorage.setItem(PERSIST_KEY, 'not json')
    const fallback = createLayoutStore().create()
    expect(fallback.store.getSnapshot().sidebar).toBe(SIDEBAR_DEFAULT)
    expect(fallback.store.getSnapshot().details).toBe(0)
  })
})
