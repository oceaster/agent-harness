// @vitest-environment jsdom
/**
 * Settings shell store: the persisted viewing state of the settings surface.
 * Two behaviours matter and both are about what a reload is allowed to do —
 * bring back an open panel open, and bring back a closed panel closed. A third
 * is what a position stored by an older build may do: the section id it kept
 * beside `open` is retired, never resolved.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createSettingsShellStore } from '../src/client/settings-shell-store.ts'

const KEY = 'dsh.settings.shell'

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('settings shell store', () => {
  it('starts closed', () => {
    const store = createSettingsShellStore().create()
    expect(store.getSnapshot()).toEqual({ open: false })
  })

  it('persists the open state under the dsh. key', () => {
    const store = createSettingsShellStore().create()
    store.actions.open()
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ open: true })
  })

  it('rehydrates an open panel — the reload case', () => {
    const before = createSettingsShellStore().create()
    before.actions.open()
    // A reload is a new instance over the same storage: nothing else carries over.
    const after = createSettingsShellStore().create()
    expect(after.getSnapshot()).toEqual({ open: true })
  })

  it('remembers the CLOSED state, so a reload does not surprise-reopen the panel', () => {
    const opened = createSettingsShellStore().create()
    opened.actions.open()
    opened.actions.close()
    const afterReload = createSettingsShellStore().create()
    expect(afterReload.getSnapshot().open).toBe(false)
  })

  it('rewrites a legacy {open, sectionId} entry without its section half', () => {
    // What the nav-rail build left behind. There is no navigation now, so the id
    // must never steer a render: it is not part of this store's state type, and
    // the durable entry — the only thing a future boot rehydrates — is rewritten
    // without it on the reader's next open or close.
    localStorage.setItem(KEY, JSON.stringify({ open: true, sectionId: 'models' }))
    const store = createSettingsShellStore().create()
    expect(store.getSnapshot().open).toBe(true)
    store.actions.close()
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ open: false })
    store.actions.open()
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({ open: true })
  })

  it('scope-free: every instance reads the same root key', () => {
    // The sidebar.settings slot is root scope, so the engine must not suffix the
    // key; two independent root instances share one entry by design.
    const first = createSettingsShellStore().create()
    first.actions.open()
    const second = createSettingsShellStore().create()
    expect(second.getSnapshot().open).toBe(true)
    expect(localStorage.getItem(`${KEY}.root`)).toBeNull()
  })

  it('a corrupt stored value falls back to the initial state instead of throwing', () => {
    localStorage.setItem(KEY, '{not json')
    const store = createSettingsShellStore().create()
    expect(store.getSnapshot()).toEqual({ open: false })
  })
})
