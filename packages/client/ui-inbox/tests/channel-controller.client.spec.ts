// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { ChannelController } from '../src/client/channel-controller.ts'
const row = { id: 'delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }
const message = { id: 'one', sender: 'delta', recipient: 'darwin', content: 'Please review', priority: 'normal', created: 1, status: 'delivered' }
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
