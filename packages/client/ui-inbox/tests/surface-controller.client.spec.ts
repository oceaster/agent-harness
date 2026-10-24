// @vitest-environment jsdom
/**
 * The wire, and the state machine behind it: what this app accepts from the page
 * that wraps it, what it refuses, and what it answers.
 *
 * Owen, 2026-10-24: the workspace must move between its interfaces without
 * loading a document, so the parent posts `dsh:open` at this window instead of
 * changing the frame's `src`. These cases hold the frozen contract from the
 * receiving side: only the parent may move the app, a message is applied only
 * when it changes something, a `dsh:open` that arrives before `dsh:ready` is
 * not lost, the token is echoed, and every reply names an EXACT origin — this
 * app never posts with `'*'`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bootIntentOf, openIntentOf } from '../src/client/surface.ts'
import { SurfaceController, parentOriginOf } from '../src/client/surface-controller.ts'

const PARENT_ORIGIN = 'http://easter.test:18095'

/** A stand-in for the window a frame runs in, with the parent's postbox. */
function bench(options: {
  readonly ancestorOrigins?: readonly string[]
  readonly referrer?: string
  readonly top?: boolean
} = {}) {
  const listeners = new Set<(event: MessageEvent) => void>()
  const posted: { message: unknown; targetOrigin: string }[] = []
  const parent = {
    postMessage: (message: unknown, targetOrigin: string): void => { posted.push({ message, targetOrigin }) },
  }
  const win = {
    parent: options.top === true ? (undefined as unknown) : parent,
    location: options.ancestorOrigins === undefined ? {} : { ancestorOrigins: options.ancestorOrigins },
    document: { referrer: options.referrer ?? '' },
    addEventListener: (_type: 'message', listener: (event: MessageEvent) => void): void => { listeners.add(listener) },
    removeEventListener: (_type: 'message', listener: (event: MessageEvent) => void): void => { listeners.delete(listener) },
  }
  if (options.top === true) win.parent = win
  const deliver = (data: unknown, from: unknown = parent, origin = PARENT_ORIGIN): void => {
    const event = { data, origin, source: from } as unknown as MessageEvent
    for (const listener of [...listeners]) listener(event)
  }
  return { win, parent, posted, deliver, listeners }
}

/** One valid `dsh:open` off the wire. */
const open = (surface: 'inbox' | 'epsilons', conversation: string | null, token = 't-1') =>
  ({ type: 'dsh:open', surface, conversation, token })

afterEach(() => { vi.restoreAllMocks() })

describe('openIntentOf: the message this app accepts', () => {
  it('accepts an address with or without a conversation and with an absent token', () => {
    expect(openIntentOf(open('epsilons', null, 'abc'))).toEqual({ surface: 'epsilons', conversation: null, token: 'abc' })
    expect(openIntentOf(open('inbox', 'delta'))).toEqual({ surface: 'inbox', conversation: 'delta', token: 't-1' })
    expect(openIntentOf({ type: 'dsh:open', surface: 'inbox', conversation: 'delta' }))
      .toEqual({ surface: 'inbox', conversation: 'delta', token: '' })
    // An empty conversation word means "no conversation asked for", which is
    // the same thing as absent — not a protocol violation.
    expect(openIntentOf({ type: 'dsh:open', surface: 'inbox', conversation: '' }))
      .toEqual({ surface: 'inbox', conversation: null, token: '' })
  })

  it('drops anything that is not exactly this contract', () => {
    const rejected: unknown[] = [
      null,
      'dsh:open',
      { type: 'dsh:route', surface: 'inbox', conversation: null, token: '' },
      { type: 'dsh:open', surface: 'chat', conversation: null, token: '' },
      { type: 'dsh:open', conversation: null, token: '' },
      // A conversation word that is not an agent id this app could open: the
      // whole message is refused rather than half-applied, because the app
      // cannot know which half the sender meant.
      { type: 'dsh:open', surface: 'inbox', conversation: '../etc/passwd', token: '' },
      { type: 'dsh:open', surface: 'inbox', conversation: 'Delta', token: '' },
      { type: 'dsh:open', surface: 'inbox', conversation: 7, token: '' },
      { type: 'dsh:open', surface: 'inbox', conversation: null, token: 7 },
    ]
    for (const data of rejected) expect(openIntentOf(data)).toBeNull()
  })
})

describe('parentOriginOf', () => {
  it('reads ancestor origins first, then the referrer, and withholds an opaque one', () => {
    expect(parentOriginOf(bench({ ancestorOrigins: [PARENT_ORIGIN] }).win as never)).toBe(PARENT_ORIGIN)
    expect(parentOriginOf(bench({ referrer: PARENT_ORIGIN + '/ai/harness' }).win as never)).toBe(PARENT_ORIGIN)
    expect(parentOriginOf(bench().win as never)).toBeNull()
    // An opaque referrer cannot name a target origin, and '*': is not an answer.
    expect(parentOriginOf(bench({ referrer: 'about:blank' }).win as never)).toBeNull()
    expect(parentOriginOf(bench({ referrer: '::not a url::' }).win as never)).toBeNull()
    // An empty ancestor entry is a hole in the list, not an origin.
    expect(parentOriginOf(bench({ ancestorOrigins: ['', 'null'], referrer: PARENT_ORIGIN }).win as never)).toBe(PARENT_ORIGIN)
  })
})

describe('SurfaceController: the address this app is showing', () => {
  it('starts from the fragment, with a conversation request the caller must retire', () => {
    const surfaces = new SurfaceController(bootIntentOf('#c/delta'))
    expect(surfaces.surface).toBe('inbox')
    expect(surfaces.hasConversationRequest()).toBe(true)
    expect(surfaces.takeConversation()).toBe('delta')
    // Consumed once: a later rows write cannot re-open what a person closed.
    expect(surfaces.hasConversationRequest()).toBe(false)
    expect(surfaces.takeConversation()).toBeNull()
    expect(surfaces.store.getSnapshot()).toEqual({ surface: 'inbox', resident: false })
  })

  it('applies a message that changes the surface and says so once', () => {
    const surfaces = new SurfaceController(bootIntentOf(''))
    const seen = vi.fn()
    surfaces.store.subscribe(seen)
    expect(surfaces.apply({ surface: 'epsilons', conversation: null })).toBe(true)
    expect(surfaces.surface).toBe('epsilons')
    expect(seen).toHaveBeenCalledTimes(1)
    // Idempotent: the same address again writes nothing and renders nothing.
    expect(surfaces.apply({ surface: 'epsilons', conversation: null })).toBe(false)
    expect(seen).toHaveBeenCalledTimes(1)
  })

  it('queues a conversation only for the inbox interface, and notifies its opener', () => {
    const surfaces = new SurfaceController(bootIntentOf(''))
    const asked = vi.fn()
    const stop = surfaces.onConversationRequest(asked)
    // The epsilon interface lists Delta's workers; a worker has no address, so
    // a conversation word there is ignored instead of half-applied.
    expect(surfaces.apply({ surface: 'epsilons', conversation: 'delta' })).toBe(true)
    expect(asked).not.toHaveBeenCalled()
    expect(surfaces.hasConversationRequest()).toBe(false)
    expect(surfaces.apply({ surface: 'inbox', conversation: 'darwin' })).toBe(true)
    expect(asked).toHaveBeenCalledTimes(1)
    expect(surfaces.takeConversation()).toBe('darwin')
    // Asking for the same conversation twice is not a second request.
    expect(surfaces.apply({ surface: 'inbox', conversation: 'darwin' })).toBe(false)
    expect(asked).toHaveBeenCalledTimes(1)
    stop()
    expect(surfaces.apply({ surface: 'inbox', conversation: 'diana' })).toBe(true)
    expect(asked).toHaveBeenCalledTimes(1)
  })

  it('remembers where the person went, so the parent repeating itself is a no-op', () => {
    const b = bench({ ancestorOrigins: [PARENT_ORIGIN] })
    const surfaces = new SurfaceController(bootIntentOf(''))
    surfaces.attach(b.win as never)
    surfaces.announce('inbox', 'delta')
    expect(b.posted).toEqual([
      { message: { type: 'dsh:ready', token: '' }, targetOrigin: PARENT_ORIGIN },
      { message: { type: 'dsh:route', surface: 'inbox', conversation: 'delta' }, targetOrigin: PARENT_ORIGIN },
    ])
    // The parent echoing the route back (to keep its URL in step) changes
    // nothing: the app is already there.
    expect(surfaces.apply({ surface: 'inbox', conversation: 'delta' })).toBe(false)
    expect(surfaces.hasConversationRequest()).toBe(false)
  })
})

describe('SurfaceController.attach: who may move this app', () => {
  it('announces itself ready, with an exact target origin and never "*"', () => {
    const b = bench({ ancestorOrigins: [PARENT_ORIGIN] })
    new SurfaceController(bootIntentOf('')).attach(b.win as never)
    expect(b.posted).toEqual([{ message: { type: 'dsh:ready', token: '' }, targetOrigin: PARENT_ORIGIN }])
    for (const message of b.posted) expect(message.targetOrigin).not.toBe('*')
  })

  it('ignores a message from any window that is not the parent, or any other origin', () => {
    const b = bench({ ancestorOrigins: [PARENT_ORIGIN] })
    const surfaces = new SurfaceController(bootIntentOf(''))
    surfaces.attach(b.win as never)
    b.deliver(open('epsilons', null), { postMessage: () => {} })
    expect(surfaces.surface).toBe('inbox')
    b.deliver(open('epsilons', null), b.parent, 'http://evil.test')
    expect(surfaces.surface).toBe('inbox')
    b.deliver(open('epsilons', null))
    expect(surfaces.surface).toBe('epsilons')
  })

  it('applies an open that arrives before anything else and echoes its token', () => {
    const b = bench({ ancestorOrigins: [PARENT_ORIGIN] })
    const surfaces = new SurfaceController(bootIntentOf(''))
    const asked = vi.fn()
    surfaces.onConversationRequest(asked)
    surfaces.attach(b.win as never)
    b.deliver(open('inbox', 'delta', 'handshake-7'))
    expect(surfaces.surface).toBe('inbox')
    expect(asked).toHaveBeenCalledTimes(1)
    expect(surfaces.takeConversation()).toBe('delta')
    // The token of the intent just applied, and only once per new token.
    expect(b.posted.at(-1)).toEqual({ message: { type: 'dsh:ready', token: 'handshake-7' }, targetOrigin: PARENT_ORIGIN })
    const count = b.posted.length
    b.deliver(open('inbox', 'delta', 'handshake-7'))
    expect(b.posted).toHaveLength(count)
    b.deliver(open('inbox', 'delta', 'handshake-8'))
    expect(b.posted).toHaveLength(count + 1)
  })

  it('pins the parent origin from the first message when the browser withheld it', () => {
    const b = bench()
    const surfaces = new SurfaceController(bootIntentOf(''))
    surfaces.attach(b.win as never)
    // Nothing to answer yet: a reply that cannot name its recipient is not sent.
    expect(b.posted).toEqual([])
    b.deliver(open('epsilons', null, 'tok'))
    expect(surfaces.surface).toBe('epsilons')
    expect(b.posted).toEqual([
      { message: { type: 'dsh:ready', token: 'tok' }, targetOrigin: PARENT_ORIGIN },
    ])
  })

  it('does not arm itself on a page nobody embedded', () => {
    const b = bench({ top: true })
    const reg = vi.spyOn(b.win, 'addEventListener')
    const surfaces = new SurfaceController(bootIntentOf('#epsilons'))
    const stop = surfaces.attach(b.win as never)
    expect(reg).not.toHaveBeenCalled()
    expect(b.posted).toEqual([])
    expect(surfaces.surface).toBe('epsilons')
    // Disposing an attach that never attached is safe (the fiber unload path).
    stop()
  })

  it('stops listening when the plugin fiber unloads', () => {
    const b = bench({ ancestorOrigins: [PARENT_ORIGIN] })
    const surfaces = new SurfaceController(bootIntentOf(''))
    const stop = surfaces.attach(b.win as never)
    expect(b.listeners.size).toBe(1)
    stop()
    expect(b.listeners.size).toBe(0)
    b.deliver(open('epsilons', null))
    expect(surfaces.surface).toBe('inbox')
  })

  it('becomes resident — both interfaces mounted — the first time the parent drives it', () => {
    const b = bench({ ancestorOrigins: [PARENT_ORIGIN] })
    const surfaces = new SurfaceController(bootIntentOf(''))
    surfaces.attach(b.win as never)
    expect(surfaces.store.getSnapshot().resident).toBe(false)
    b.deliver(open('inbox', null))
    expect(surfaces.store.getSnapshot()).toEqual({ surface: 'inbox', resident: true })
    // A refused message is not the parent driving anything.
    const fresh = bench({ ancestorOrigins: [PARENT_ORIGIN] })
    const other = new SurfaceController(bootIntentOf(''))
    other.attach(fresh.win as never)
    fresh.deliver({ type: 'dsh:open', surface: 'nowhere' })
    expect(other.store.getSnapshot().resident).toBe(false)
  })
})
