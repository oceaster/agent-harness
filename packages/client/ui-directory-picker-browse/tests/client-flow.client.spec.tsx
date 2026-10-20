// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { DirectoryListing } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { DirectoryFlowOwnerProps } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { apply, inject } from '../src/client/index.ts'
import { BrowseDirectoryFlow } from '../src/client/flow.ts'
import { apply as nodeApply } from '../src/index.ts'

// The service reads its initial locale from the browser; these specs assert
// the shipped Chinese copy, so they state the browser they assume.
usePinnedBrowserLanguages('zh-CN')

afterEach(cleanup)

// One hole remains: the sidebar browser's. The conversation hero's hole went
// with the hero workspace chip (FORK-NOTES "Inbox sidebar").
const HOLES = ['sidebar.workspaces.directoryFlow'] as const

const HOME = '/home/u'
const homeListing: DirectoryListing = {
  path: HOME,
  home: HOME,
  crumbs: [{ name: '/', path: '/', hidden: false }, { name: 'u', path: HOME, hidden: false }],
  entries: [{ name: 'Documents', path: `${HOME}/Documents`, hidden: false }],
  truncated: false,
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  ctx.provide('locale', new LocaleRuntime(ctx))
  const listDirectory = vi.fn(async (): Promise<DirectoryListing> => homeListing)
  const createDirectory = vi.fn(async (path: string, name: string) => `${path}/${name}`)
  ctx.provide('workspaces', { listDirectory, createDirectory } as never)
  const slots = ctx.get('slots') as SlotRegistry
  const declare = () => slots.register({
    name: 'root',
    children: Object.fromEntries(HOLES.map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  return { ctx, slots, listDirectory, createDirectory, declare }
}

function owner(overrides: Partial<DirectoryFlowOwnerProps> = {}): DirectoryFlowOwnerProps {
  return {
    open: true, busy: false,
    onPicked: vi.fn(), onCancel: vi.fn(), onError: vi.fn(),
    ...overrides,
  }
}

describe('directory-picker-browse client half', () => {
  it('declares the services it drives', () => {
    expect(inject).toEqual(['slots', 'workspaces', 'locale'])
  })

  it('fills the directory-flow hole for declarations before or after apply, and leaves with its fiber', async () => {
    const before = await bench()
    before.declare()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    // Registry-contribution disposal proof: the fiber going down empties the holes.
    await fiber.dispose()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declare()
    await Promise.resolve()
    for (const hole of HOLES) expect(after.slots.entries(hole)).toHaveLength(1)
  })


  it('rolls back the zh dictionary when a rival already owns the namespace en slot', async () => {
    const b = await bench()
    b.declare()
    const locale = b.ctx.get('locale') as LocaleRuntime
    const disposeRival = locale.register('directory-browser', 'en', { 'browser.title': 'rival' })
    const rejections: unknown[] = []
    const onUnhandled = (reason: unknown): void => { rejections.push(reason) }
    // cordis re-raises the apply throw as a late rejection (installFailLoud's contract).
    process.on('unhandledRejection', onUnhandled)
    try {
      const fiber = b.ctx.plugin({ inject: [...inject], apply })
      await expect(fiber.await()).rejects.toThrow(/already has locale/)
      // The zh registration rolled back with the failure: once the rival
      // leaves, a fresh registrant owns the whole namespace again.
      disposeRival()
      const disposeZh = locale.register('directory-browser', 'zh', { 'browser.title': '空闲' })
      disposeZh()
    } finally {
      await new Promise(resolve => setTimeout(resolve, 0))
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('registers the dialog dictionaries and binds this package namespace', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries(HOLES[0])[0]!
    const injected = (entry.inject as () => { t: (key: string) => string })()
    // zh is the shipped default locale.
    expect(injected.t('browser.title')).toBe('选择工作区目录')
    expect(injected.t('browser.newFolder')).toBe('新建文件夹')
    expect(injected.t('browser.showHidden')).toBe('显示隐藏文件')
  })

  it('drives the injected browse calls through the hole entry', async () => {
    const b = await bench()
    b.declare()
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const entry = b.slots.entries(HOLES[0])[0]!
    const injected = (entry.inject as () => {
      listDirectory: (path?: string) => Promise<DirectoryListing>
      createDirectory: (path: string, name: string) => Promise<string>
    })()
    await expect(injected.listDirectory()).resolves.toBe(homeListing)
    await expect(injected.createDirectory(HOME, 'fresh')).resolves.toBe(`${HOME}/fresh`)
    expect(b.listDirectory).toHaveBeenCalledOnce()
    expect(b.createDirectory).toHaveBeenCalledWith(HOME, 'fresh')
  })

  it('adapts the owner conversation onto the dialog: confirm picks, dismissal cancels', async () => {
    const props = owner()
    const listDirectory = vi.fn(async (): Promise<DirectoryListing> => homeListing)
    const t = (key: string): string => key
    render(
      <BrowseDirectoryFlow
        {...props}
        listDirectory={listDirectory}
        createDirectory={vi.fn(async () => '')}
        t={t}
      />,
    )
    // The dialog opened at home; its confirm (browser.open) adopts the listed level.
    const openButton = screen.getByRole<HTMLButtonElement>('button', { name: 'browser.open' })
    await waitFor(() => { expect(openButton.disabled).toBe(false) })
    fireEvent.click(openButton)
    expect(props.onPicked).toHaveBeenCalledWith(HOME)
    fireEvent.click(screen.getByRole('button', { name: 'browser.cancel' }))
    expect(props.onCancel).toHaveBeenCalled()
    expect(props.onError).not.toHaveBeenCalled()
  })

  it('renders nothing while the flow is closed', () => {
    const view = render(
      <BrowseDirectoryFlow
        {...owner({ open: false })}
        listDirectory={vi.fn(async () => homeListing)}
        createDirectory={vi.fn(async () => '')}
        t={key => key}
      />,
    )
    expect(view.container.innerHTML).toBe('')
  })
})

describe('directory-picker-browse node half', () => {
  // The invariant companion is mounted by the vitest-wide invariant host on
  // every Context this suite creates; its registration is covered there.
  it('the node apply is an inert loader seat', () => {
    expect(() => { nodeApply() }).not.toThrow()
  })
})
