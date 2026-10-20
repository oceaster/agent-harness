// @vitest-environment jsdom
/**
 * Settings shell store: the persisted viewing state of the settings surface.
 * Two behaviours matter and both are about what a reload is allowed to do —
 * bring back the same section, and bring back a closed panel closed.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSettingsShellStore } from '../src/client/settings-shell-store.ts'

const KEY = 'dsh.settings.shell'

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('settings shell store', () => {
  it('starts closed with no section chosen', () => {
    const store = createSettingsShellStore().create()
    expect(store.getSnapshot()).toEqual({ open: false, sectionId: null })
  })

  it('persists the open state and the section under the dsh. key', () => {
    const store = createSettingsShellStore().create()
    store.actions.open()
    store.actions.select('models')
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ open: true, sectionId: 'models' })
  })

  it('rehydrates open on the same section — the reload case', () => {
    const before = createSettingsShellStore().create()
    before.actions.open()
    before.actions.select('plugins')
    // A reload is a new instance over the same storage: nothing else carries over.
    const after = createSettingsShellStore().create()
    expect(after.getSnapshot()).toEqual({ open: true, sectionId: 'plugins' })
  })

  it('remembers the CLOSED state, so a reload does not surprise-reopen the panel', () => {
    const opened = createSettingsShellStore().create()
    opened.actions.open()
    opened.actions.select('models')
    opened.actions.close()
    const afterReload = createSettingsShellStore().create()
    expect(afterReload.getSnapshot().open).toBe(false)
  })

  it('closing keeps the reading position, so a reopen does not reset to the first section', () => {
    const store = createSettingsShellStore().create()
    store.actions.open()
    store.actions.select('agent-presets')
    store.actions.close()
    // The last section the reader saw is what a reopen should land on; clearing
    // it would silently fall back to the first nav row.
    expect(store.getSnapshot().sectionId).toBe('agent-presets')
    store.actions.open()
    expect(store.getSnapshot()).toEqual({ open: true, sectionId: 'agent-presets' })
  })

  it('openSection shows one section and opens the panel in a single write', () => {
    const seen: string[] = []
    const store = createSettingsShellStore().create()
    store.subscribe(() => { seen.push(JSON.stringify(store.getSnapshot())) })
    store.actions.openSection('models')
    // Onboarding reaches a section directly: one transition, not open-then-select
    // (which would flash the previously stored section under a watcher).
    expect(seen).toEqual(['{"open":true,"sectionId":"models"}'])
  })

  it('scope-free: every instance reads the same root key', () => {
    // The sidebar.settings slot is root scope, so the engine must not suffix the
    // key; two independent root instances share one entry by design.
    const first = createSettingsShellStore().create()
    first.actions.select('general')
    const second = createSettingsShellStore().create()
    expect(second.getSnapshot().sectionId).toBe('general')
    expect(localStorage.getItem(`${KEY}.general`)).toBeNull()
  })

  it('a corrupt stored value falls back to the initial state instead of throwing', () => {
    localStorage.setItem(KEY, '{not json')
    const store = createSettingsShellStore().create()
    expect(store.getSnapshot()).toEqual({ open: false, sectionId: null })
  })
})
