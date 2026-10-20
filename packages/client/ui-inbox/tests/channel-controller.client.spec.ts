// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChannelController } from '../src/client/channel-controller.ts'
const row = { id: 'delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }
const otherRow = { id: 'delta-diana', name: 'Delta-Diana', agents: ['delta', 'diana'] }
const message = { id: 'one', sender: 'delta', recipient: 'darwin', content: 'Please review', priority: 'normal', created: 1, status: 'delivered' }
/** The store key the controller persists its open channel under. */
const PERSIST_KEY = 'dsh.inbox.channel'
beforeEach(() => { localStorage.clear() })
afterEach(() => { vi.unstubAllGlobals() })
it('loads the authenticated channel and its read-only history, clearing only after the explicit callback', async () => {
  const fetcher = vi.fn((path: string, _options?: RequestInit) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/clear') ? { cleared: true } : path.endsWith('/channels') ? { channels: [row] } : { messages: [message] },
  ), { status: 200 })))
  vi.stubGlobal('fetch', fetcher)
  const controller = new ChannelController()
  await controller.load()
  await controller.open('foreign-channel')
  expect(fetcher).toHaveBeenCalledTimes(1)
  await controller.open(row.id)
  expect(controller.store.getSnapshot().messages).toEqual([message])
  expect(fetcher).toHaveBeenCalledTimes(2)
  await controller.clear()
  expect(fetcher.mock.calls.at(-1)).toEqual(['/v1/browser/inbox/channels/delta-darwin/clear', expect.objectContaining({ method: 'POST' })])
  expect(controller.store.getSnapshot().messages).toEqual([])
  controller.close()
  expect(controller.store.getSnapshot().selected).toBeNull()
})
it('keeps history and exposes a failed clear instead of pretending it succeeded', async () => {
  const controller = new ChannelController()
  controller.store.set({ rows: [row], selected: row, messages: [message], loading: false, error: null })
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 503 }))))
  await controller.clear()
  expect(controller.store.getSnapshot().messages).toEqual([message])
  expect(controller.store.getSnapshot().error).toContain('could not be cleared')
})
it('a refresh started before clearing cannot restore cleared history', async () => {
  const controller = new ChannelController()
  controller.store.set({ rows: [row], selected: row, messages: [message], loading: false, error: null })
  let resolve!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn((path: string) => path.endsWith('/clear')
    ? Promise.resolve(new Response('{"cleared":true}'))
    : new Promise<Response>((done) => { resolve = done })))
  const refresh = controller.refresh()
  await controller.clear()
  resolve(new Response(JSON.stringify({ messages: [message] })))
  await refresh
  expect(controller.store.getSnapshot().messages).toEqual([])
})

it('persists the id of the channel the person opened, and only the id', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row, otherRow] } : { messages: [message] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  await controller.open(row.id)
  // A row object is server data (name, agents, presence); storing it would
  // restore a stale channel, so the entry is the id alone.
  expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({ channelId: 'delta-darwin' })
  controller.close()
  expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({ channelId: null })
})

it('restores the channel that was open: the selection and the page in one step', async () => {
  localStorage.setItem(PERSIST_KEY, JSON.stringify({ channelId: 'delta-diana' }))
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row, otherRow] } : { messages: [message] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  const openPage = vi.fn()
  const restored = await controller.restorePersisted(openPage)
  expect(restored).toBe('delta-diana')
  // One write, not two writers racing: the channel is the selection when the
  // page is selected, so the channel page cannot paint a frame late.
  expect(openPage).toHaveBeenCalledTimes(1)
  expect(controller.store.getSnapshot().selected?.id).toBe('delta-diana')
  expect(controller.store.getSnapshot().messages).toEqual([message])
  expect(controller.store.getSnapshot().error).toBeNull()
})

it('does nothing when no channel was open', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row] } : { messages: [] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  const openPage = vi.fn()
  expect(await controller.restorePersisted(openPage)).toBeNull()
  expect(openPage).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().selected).toBeNull()
})

it('a persisted channel that no longer resolves falls back with no banner and no stuck loading', async () => {
  localStorage.setItem(PERSIST_KEY, JSON.stringify({ channelId: 'removed-channel' }))
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row] } : { messages: [] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  const openPage = vi.fn()
  expect(await controller.restorePersisted(openPage)).toBeNull()
  // The ordinary conversation default stands: nothing paints as the channel,
  // nothing reports a failure, nothing waits.
  expect(openPage).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().selected).toBeNull()
  expect(controller.store.getSnapshot().error).toBeNull()
  expect(controller.store.getSnapshot().loading).toBe(false)
  // And the dead selection does not survive to the next reload.
  expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({ channelId: null })
})

it('holds the persisted channel while the rows are still unknown', async () => {
  localStorage.setItem(PERSIST_KEY, JSON.stringify({ channelId: 'delta-darwin' }))
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 503 }))))
  const controller = new ChannelController()
  await controller.load()
  expect(controller.store.getSnapshot().rows).toEqual([])
  const openPage = vi.fn()
  // Nothing to resolve against yet: the selection is kept, not reported gone.
  expect(await controller.restorePersisted(openPage)).toBeNull()
  expect(openPage).not.toHaveBeenCalled()
  expect(JSON.parse(localStorage.getItem(PERSIST_KEY)!)).toEqual({ channelId: 'delta-darwin' })
  // The id survives to the next read, which then restores it.
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row] } : { messages: [message] },
  ), { status: 200 }))))
  await controller.load()
  expect(await controller.restorePersisted(openPage)).toBe('delta-darwin')
  expect(openPage).toHaveBeenCalledTimes(1)
})
