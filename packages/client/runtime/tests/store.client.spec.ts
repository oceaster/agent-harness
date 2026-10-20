import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore, defineStore, shallowEqual } from '../src/client/contract/store.ts'

interface State {
  a: { n: number }
  b: { list: string[] }
}

const init = (): State => ({ a: { n: 1 }, b: { list: ['x'] } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createSnapshotStore', () => {
  it('applies update through a draft and preserves untouched branch references', () => {
    const store = createSnapshotStore(init())
    const before = store.getSnapshot()
    store.update((d) => { d.a.n = 2 })
    const after = store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.a.n).toBe(2)
    expect(after.b).toBe(before.b)
  })

  it('notifies synchronously per update by default', () => {
    const store = createSnapshotStore(init())
    const seen: number[] = []
    store.subscribe(() => { seen.push(store.getSnapshot().a.n) })
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    expect(seen).toEqual([2, 3])
  })

  it('coalesces a frame of updates into one notification in raf mode', () => {
    const frame: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.push(cb)
      return frame.length
    })
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    store.update((d) => { d.b.list.push('y') })
    expect(spy).not.toHaveBeenCalled()
    expect(frame).toHaveLength(1)
    frame.shift()!(0)
    expect(spy).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().a.n).toBe(3)
    // Next frame batches independently.
    store.update((d) => { d.a.n = 4 })
    expect(frame).toHaveLength(1)
    frame.shift()!(0)
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('falls back to microtask batching in raf mode without requestAnimationFrame', async () => {
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    store.update((d) => { d.a.n = 3 })
    expect(spy).not.toHaveBeenCalled()
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('unsubscribes raf-mode listeners', () => {
    const frame: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      frame.push(cb)
      return frame.length
    })
    const store = createSnapshotStore(init(), { flush: 'raf' })
    const spy = vi.fn()
    const off = store.subscribe(spy)
    store.update((d) => { d.a.n = 2 })
    off()
    frame.shift()!(0)
    expect(spy).not.toHaveBeenCalled()
  })

  it('replaces state wholesale via set and freezes it outside production', () => {
    const store = createSnapshotStore(init())
    const next = init()
    store.set(next)
    expect(store.getSnapshot()).toBe(next)
    expect(() => { (store.getSnapshot().a).n = 9 }).toThrow()
  })

  it('freezes update produce output outside production (immer dev freeze)', () => {
    const store = createSnapshotStore(init())
    store.update((d) => { d.a.n = 2 })
    expect(() => { (store.getSnapshot().a).n = 9 }).toThrow()
  })

  it('rehydrates primitive state whole, not spread into index keys', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const store = createSnapshotStore<string>('', { persist: { name: 'spec-draft' } })
    store.set('hello')
    const revived = createSnapshotStore<string>('', { persist: { name: 'spec-draft' } })
    expect(revived.getSnapshot()).toBe('hello')
  })

  it('persists to localStorage under the given name and rehydrates', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const store = createSnapshotStore(init(), { persist: { name: 'spec-store' } })
    store.update((d) => { d.a.n = 42 })
    expect(backing.has('spec-store')).toBe(true)
    const revived = createSnapshotStore(init(), { persist: { name: 'spec-store' } })
    expect(revived.getSnapshot().a.n).toBe(42)
  })
})

describe('createSnapshotStore: subset persistence (persist.partial)', () => {
  /** A state that mixes a durable preference with viewport-derived fields. */
  interface Mixed { width: number; viewport: boolean; page: string | null }
  const mixedInit = (): Mixed => ({ width: 280, viewport: false, page: null })
  const widthsOnly = (state: Mixed): Partial<Mixed> => ({ width: state.width })

  /** In-memory localStorage stand-in (same shape the other persistence tests use). */
  function memoryStorage(): Map<string, string> {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    return backing
  }

  it('stores only the picked subset, never the whole state', () => {
    const backing = memoryStorage()
    const store = createSnapshotStore(mixedInit(), {
      persist: { name: 'spec-partial', partial: widthsOnly },
    })
    store.update((d) => { d.width = 400; d.viewport = true; d.page = 'agent-channel' })
    // The excluded fields are not in the entry at all: a stored viewport
    // reading would fight whatever re-measures it, and `page` has one writer.
    expect(JSON.parse(backing.get('spec-partial')!)).toEqual({ width: 400 })
  })

  it('restores the subset over init, so excluded fields keep their defaults', () => {
    const backing = memoryStorage()
    backing.set('spec-partial', JSON.stringify({ width: 400 }))
    const revived = createSnapshotStore(mixedInit(), {
      persist: { name: 'spec-partial', partial: widthsOnly },
    })
    expect(revived.getSnapshot()).toEqual({ width: 400, viewport: false, page: null })
  })

  it('leaves a key an older build never wrote at its init default', () => {
    memoryStorage().set('spec-partial-gap', JSON.stringify({}))
    const revived = createSnapshotStore(mixedInit(), {
      persist: { name: 'spec-partial-gap', partial: widthsOnly },
    })
    expect(revived.getSnapshot()).toEqual(mixedInit())
  })

  it('survives corrupt JSON: init state, a logged failure, and persistence that still works', () => {
    const backing = memoryStorage()
    backing.set('spec-corrupt', '{not json')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const store = createSnapshotStore(mixedInit(), {
        persist: { name: 'spec-corrupt', partial: widthsOnly },
      })
      expect(store.getSnapshot()).toEqual(mixedInit())
      expect(errors).toHaveBeenCalledTimes(1)
      // The store is fully usable, and its next write replaces the bad entry.
      store.update((d) => { d.width = 500 })
      expect(store.getSnapshot().width).toBe(500)
      expect(JSON.parse(backing.get('spec-corrupt')!)).toEqual({ width: 500 })
    } finally {
      errors.mockRestore()
    }
  })

  it('ignores a non-object entry instead of spreading it into the state', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const entry of ['"hello"', '5', 'null', '[1,2]']) {
        const backing = memoryStorage()
        backing.set('spec-foreign', entry)
        const store = createSnapshotStore(mixedInit(), {
          persist: { name: 'spec-foreign', partial: widthsOnly },
        })
        // A whole-value entry from an older build (or hand-edited garbage)
        // cannot be merged; the store starts from init rather than from
        // `{0:'h',1:'e',...}`-shaped corruption.
        expect(store.getSnapshot()).toEqual(mixedInit())
        vi.unstubAllGlobals()
      }
    } finally {
      errors.mockRestore()
    }
  })

  it('attachPersistence still writes whole values for a picker-free declaration', () => {
    const backing = memoryStorage()
    const store = createSnapshotStore(mixedInit(), { persist: { name: 'spec-whole' } })
    store.update((d) => { d.width = 400; d.page = 'p' })
    expect(JSON.parse(backing.get('spec-whole')!)).toEqual({ width: 400, viewport: false, page: 'p' })
  })
})

describe('defineStore', () => {
  const declare = () => defineStore({
    init: () => ({ selection: null as string | null, draft: '' }),
    actions: {
      select: (d, target: string) => { d.selection = target },
      setDraft: (d, text: string) => { d.draft = text },
      clearDraft: (d) => { d.draft = '' },
    },
  })

  it('create() yields a live instance: fresh init state, selector-visible action writes', () => {
    const inst = declare().create()
    expect(inst.store.getSnapshot()).toEqual({ selection: null, draft: '' })
    inst.actions.setDraft('hello')
    inst.actions.select('m1')
    expect(inst.store.getSnapshot()).toEqual({ selection: 'm1', draft: 'hello' })
    inst.actions.clearDraft()
    expect(inst.store.getSnapshot().draft).toBe('')
  })

  it('bakes draft-stripped actions that write through update (draft mutation, not replacement)', () => {
    const inst = declare().create()
    const before = inst.store.getSnapshot()
    inst.actions.setDraft('x')
    const after = inst.store.getSnapshot()
    expect(after).not.toBe(before)
    expect(after.selection).toBe(before.selection)   // untouched branch preserved (immer path)
  })

  it('creates independent instances per create() call (the handle is a spec, not a singleton)', () => {
    const handle = declare()
    const a = handle.create()
    const b = handle.create()
    a.actions.setDraft('only-a')
    expect(b.store.getSnapshot().draft).toBe('')
  })

  it('suffixes the persist key with the scope key: per-session persistence plus clearPersisted cleanup', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const handle = defineStore({
      init: () => ({ draft: '' }),
      persist: 'spec.chat',
      actions: { setDraft: (d, text: string) => { d.draft = text } },
    })
    handle.create('s1').actions.setDraft('one')
    handle.create('s2').actions.setDraft('two')
    handle.create().actions.setDraft('root')
    expect(JSON.parse(backing.get('spec.chat.s1')!)).toEqual({ draft: 'one' })
    expect(JSON.parse(backing.get('spec.chat.s2')!)).toEqual({ draft: 'two' })
    expect(JSON.parse(backing.get('spec.chat')!)).toEqual({ draft: 'root' })
    // Rehydration honors the same suffixed key.
    expect(handle.create('s1').store.getSnapshot().draft).toBe('one')
    // Scope-death cleanup removes exactly the suffixed key.
    handle.create('s1').clearPersisted()
    expect(backing.has('spec.chat.s1')).toBe(false)
    expect(backing.has('spec.chat.s2')).toBe(true)
    expect(backing.has('spec.chat')).toBe(true)
  })

  it('accepts the { name, partial } form: subset entry, scope suffix, clearPersisted', () => {
    const backing = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => backing.get(k) ?? null,
      setItem: (k: string, v: string) => { backing.set(k, v) },
      removeItem: (k: string) => { backing.delete(k) },
    })
    const handle = defineStore({
      init: () => ({ width: 280, viewport: false }),
      persist: { name: 'spec.panels', partial: (s: { width: number; viewport: boolean }) => ({ width: s.width }) },
      actions: { resize: (d, px: number) => { d.width = px }, measure: (d) => { d.viewport = true } },
    })
    handle.create().actions.resize(400)
    handle.create().actions.measure()
    expect(JSON.parse(backing.get('spec.panels')!)).toEqual({ width: 400 })
    // The spec stays a valid ui-slots StoreSpec (the storage name), with the
    // picker carried beside it for the engine's own create().
    expect(handle.spec.persist).toBe('spec.panels')
    expect(handle.spec.partial).toBeTypeOf('function')
    // The scope key suffixes the same key, and the picker still applies.
    handle.create('s1').actions.resize(500)
    expect(JSON.parse(backing.get('spec.panels.s1')!)).toEqual({ width: 500 })
    const revived = handle.create('s1')
    expect(revived.store.getSnapshot()).toEqual({ width: 500, viewport: false })
    revived.clearPersisted()
    expect(backing.has('spec.panels.s1')).toBe(false)
  })

  it('clearPersisted is a no-op without a persist declaration or without storage', () => {
    const inst = declare().create('s1')   // no persist key declared
    expect(() => { inst.clearPersisted() }).not.toThrow()
    const persisting = defineStore({
      init: () => ({ n: 0 }),
      persist: 'spec.nostorage',
      actions: { inc: (d) => { d.n += 1 } },
    }).create()
    // jsdom-less lane: localStorage may exist here, so simulate its absence.
    vi.stubGlobal('localStorage', undefined)
    expect(() => { persisting.clearPersisted() }).not.toThrow()
  })

  it('swallows storage failures in clearPersisted (same non-fatal contract as persistence)', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => { throw new Error('quota / private mode') },
    })
    const inst = defineStore({
      init: () => ({ n: 0 }),
      persist: 'spec.throwing',
      actions: { inc: (d) => { d.n += 1 } },
    }).create()
    expect(() => { inst.clearPersisted() }).not.toThrow()
  })
})

describe('shallowEqual', () => {
  it('matches one-level-equal objects and rejects deeper drift', () => {
    const leaf = { deep: 1 }
    expect(shallowEqual({ x: 1, y: leaf }, { x: 1, y: leaf })).toBe(true)
    expect(shallowEqual({ x: 1, y: { deep: 1 } }, { x: 1, y: { deep: 1 } })).toBe(false)
    expect(shallowEqual([1, 2], [1, 2])).toBe(true)
    expect(shallowEqual([1, 2], [2, 1])).toBe(false)
  })
})
