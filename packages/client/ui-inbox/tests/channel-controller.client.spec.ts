// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ChannelController } from '../src/client/channel-controller.ts'
const row = { id: 'delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }
const otherRow = { id: 'delta-diana', name: 'Delta-Diana', agents: ['delta', 'diana'] }
const message = { id: 'one', sender: 'delta', recipient: 'darwin', content: 'Please review', priority: 'normal', created: 1, status: 'delivered' }
/** The key the channel selection used to persist itself under (now retired). */
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

it('keeps no durable copy of the selection: the memory owns where you were', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row, otherRow] } : { messages: [message] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  await controller.open(row.id)
  // The channel id used to be persisted here (`dsh.inbox.channel`), which made
  // two durable writers of one fact. The record in surface-memory.ts is the only
  // one now, so this controller writes no storage key of its own.
  expect(localStorage.getItem(PERSIST_KEY)).toBeNull()
  expect(controller.store.getSnapshot().selected?.id).toBe(row.id)
  controller.close()
  expect(controller.store.getSnapshot().selected).toBeNull()
  expect(localStorage.getItem(PERSIST_KEY)).toBeNull()
})

it('reopens the channel a record names: the selection and the page in one step', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row, otherRow] } : { messages: [message] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  const openPage = vi.fn()
  expect(await controller.reopen(otherRow.id, openPage)).toBe('opened')
  // One write, not two writers racing: the channel is the selection when the
  // page is selected, so the channel page cannot paint a frame late.
  expect(openPage).toHaveBeenCalledTimes(1)
  expect(controller.store.getSnapshot().selected?.id).toBe(otherRow.id)
  expect(controller.store.getSnapshot().messages).toEqual([message])
  expect(controller.store.getSnapshot().error).toBeNull()
})

it('does not refetch a channel that is still the selection', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row] } : { messages: [message] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  await controller.open(row.id)
  const calls = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length
  const openPage = vi.fn()
  // A round trip to the other interface and back must not throw away the
  // transcript that is already on screen to fetch it again.
  expect(await controller.reopen(row.id, openPage)).toBe('opened')
  expect(openPage).toHaveBeenCalledTimes(1)
  expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(calls)
  expect(controller.store.getSnapshot().messages).toEqual([message])
})

it('reports a channel id that no longer resolves, and paints nothing', async () => {
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row] } : { messages: [] },
  ), { status: 200 }))))
  const controller = new ChannelController()
  await controller.load()
  const openPage = vi.fn()
  expect(await controller.reopen('removed-channel', openPage)).toBe('unresolved')
  // The surface's own default stands: nothing paints as the channel, nothing
  // reports a failure, nothing waits.
  expect(openPage).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().selected).toBeNull()
  expect(controller.store.getSnapshot().error).toBeNull()
  expect(controller.store.getSnapshot().loading).toBe(false)
})

it('holds an unread channel list open rather than calling a channel gone', async () => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}', { status: 503 }))))
  const controller = new ChannelController()
  await controller.load()
  expect(controller.store.getSnapshot().rows).toEqual([])
  const openPage = vi.fn()
  // Nothing to resolve against yet: `unknown`, not `unresolved` — the caller
  // keeps the record and the next read tries again.
  expect(await controller.reopen(row.id, openPage)).toBe('unknown')
  expect(openPage).not.toHaveBeenCalled()
  vi.stubGlobal('fetch', vi.fn((path: string) => Promise.resolve(new Response(JSON.stringify(
    path.endsWith('/channels') ? { channels: [row] } : { messages: [message] },
  ), { status: 200 }))))
  await controller.load()
  expect(await controller.reopen(row.id, openPage)).toBe('opened')
  expect(openPage).toHaveBeenCalledTimes(1)
})
