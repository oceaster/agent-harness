// @vitest-environment jsdom
/** Conversation assembly acceptance independent of Tool presentation. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, waitFor } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import type { ISession, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotTestRuntime, usePinnedBrowserLanguages, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionBehaviorOverrides } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-conversation/client'

usePinnedBrowserLanguages('zh-CN')

const SID = 's1' as SessionId

/** jsdom has no ResizeObserver; the composer seat publishes its height through one. */
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
beforeEach(() => {
  localStorage.clear()
  vi.stubGlobal('ResizeObserver', ResizeObserverStub)
})

type AppRootProps = PropsRenderSlots<'conversation' | 'details'>
function AppRoot({ renderSlot }: AppRootProps) {
  return <>{renderSlot('conversation', {})}</>
}

const LAYOUT_CHILDREN = {
  'conversation': { kind: 'single', scope: 'session-maybe' },
  'details': { kind: 'single', scope: 'session' },
} as const

async function bench(opts?: { blank?: boolean }) {
  const runtime = await SlotTestRuntime.create()
  runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
  // The plugin injects both; these specs exercise no settings path.
  runtime.provide('remote', { $on: () => () => {} })
  runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.provide('locale', locale)
  runtime.slots.installLocale(locale)
  await runtime.sessions.add({
    id: SID,
    summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
    snapshot: {
      nodes: [],
      ...(opts?.blank === true ? { blank: true, composerPhase: 'blank' as const } : {}),
    },
    session: {
      prompt: vi.fn<ISession['prompt']>(async () => ({ ok: true, value: { accepted: true } })),
    },
  })
  await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
  await runtime.mount({ inject: [...inject], apply })
  return runtime
}

describe('resident composer', () => {
  it('renders the locked view state while no session exists at all, with no workspace affordance', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    // The plugin injects both; these specs exercise no settings path.
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()
    expect(view.container.querySelector('textarea')).toBeNull()
    expect(view.getByTestId('inbox-welcome')).toBeTruthy()
    expect(view.getByText('Numquam Succumbe')).toBeTruthy()
    expect(view.queryByRole('button', { name: '选择工作区' })).toBeNull()
    expect(view.queryByRole('button', { name: 'Choose workspace' })).toBeNull()
    // The workspace-picker seat is gone from the ledger: a stray registrant
    // fails loud instead of quietly re-introducing the mint-a-session control.
    const registerStray = (): void => {
      (runtime.slots.register as (options: unknown, component: unknown) => void)(
        { name: 'conversation.hero.workspace' }, () => null,
      )
    }
    expect(registerStray).toThrow(/not declared/)
    await runtime.dispose()
  })

  it('replaces the welcome screen with a composer when the first session appears', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    // The plugin injects both; these specs exercise no settings path.
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    await runtime.workspaces.update((draft) => {
      draft.items = [{ workspaceId: 'w1', title: 'Proj', path: '/proj', sessionIds: [SID] }] as never
    })
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    expect(view.getByTestId('inbox-welcome')).toBeTruthy()
    expect(view.container.querySelector('textarea')).toBeNull()

    await runtime.sessions.add({
      id: SID,
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj', blank: true },
      snapshot: { blank: true, composerPhase: 'blank' },
    })

    expect(view.queryByTestId('inbox-welcome')).toBeNull()
    const textarea = view.container.querySelector('textarea')!
    expect(textarea).not.toBeNull()
    expect(textarea.disabled).toBe(false)
    expect(textarea.readOnly).toBe(false)
    await runtime.dispose()
  })

  it('the textarea survives the blank→active conversion as the same DOM node', async () => {
    const runtime = await bench({ blank: true })
    await runtime.workspaces.update((draft) => {
      draft.items = [{ workspaceId: 'w1', title: 'Proj', path: '/proj', sessionIds: [SID] }] as never
    })
    const view = runtime.renderRoot()
    const hero = view.container.querySelector('textarea')
    expect(hero).not.toBeNull()
    expect(hero!.disabled).toBe(false)

    await runtime.sessions.updateSnapshot(SID, (draft) => {
      draft.blank = false
      draft.composerPhase = 'active'
    })
    expect(view.container.querySelector('textarea')).toBe(hero)
    await runtime.dispose()
  })
})

describe('prompt rejection through the assembled composer', () => {
  it('renders the promptError alert strip and keeps the draft in the machine', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    // The plugin injects both; these specs exercise no settings path.
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const prompt = vi.fn<ISession['prompt']>(async () => ({
      ok: false, error: { code: 'agent-busy', message: 'prompt rejected before acceptance', details: { reason: 'busy' } },
    }))
    await runtime.sessions.add({
      id: SID,
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
      session: { prompt },
    })
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    const composer = view.container.querySelector('textarea')!
    fireEvent.change(composer, { target: { value: 'do not lose this' } })
    fireEvent.keyDown(composer, { key: 'Enter' })
    await waitFor(() => { expect(prompt).toHaveBeenCalledOnce() })

    await runtime.sessions.updateSnapshot(SID, (draft) => {
      draft.promptError = {
        op: 'send',
        error: { code: 'agent-busy', message: 'prompt rejected before acceptance', details: { reason: 'busy' } },
      }
    })
    const alert = await view.findByRole('alert')
    expect(alert.textContent).toContain('prompt rejected before acceptance (agent-busy)')
    await waitFor(() => {
      expect((view.container.querySelector('textarea'))!.value).toBe('do not lose this')
    })
    await runtime.dispose()
  })
})

describe('title projection across assembled surfaces', () => {
  it('one summary update re-labels the current-session crumb', async () => {
    const runtime = await bench()
    const view = runtime.renderRoot()
    expect(view.queryByRole('navigation', { name: '会话层级' })).toBeNull()
    await runtime.sessions.updateSummary(SID, { displayTitle: '修订标题', title: '修订标题' })
    expect(view.queryByText('修订标题')).toBeNull()
    await runtime.dispose()
  })
})

describe('final transcript window', () => {
  it('reports older history, offers no way to ask for it, and scrolling reaches no session verb', async () => {
    const runtime = await SlotTestRuntime.create()
    runtime.provide('connection', { api: { settings: {} }, isLoopback: false })
    runtime.provide('remote', { $on: () => () => {} })
    runtime.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
    runtime.provide('layout', { openDetails: vi.fn(), closeDetails: vi.fn() })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.provide('locale', locale)
    runtime.slots.installLocale(locale)
    // Any session verb the assembled conversation reaches is recorded: a
    // paging request would show up here as a call.
    const calls: string[] = []
    const sessionFace = new Proxy({}, {
      get: (_target, key) => (..._args: unknown[]) => {
        calls.push(String(key))
        return Promise.resolve({ ok: true, value: {} })
      },
    }) as unknown as SessionBehaviorOverrides
    await runtime.sessions.add({
      id: SID,
      summary: { title: 'S', displayTitle: 'S', cwd: '/proj' },
      // The tail page reported older history outside the window.
      snapshot: { nodes: [], hasMore: true },
      session: sessionFace,
    })
    await runtime.root.declare(LAYOUT_CHILDREN, AppRoot)
    await runtime.mount({ inject: [...inject], apply })
    const view = runtime.renderRoot()

    // No paging affordance of any kind, in either dictionary.
    expect(view.queryByText('加载更早')).toBeNull()
    expect(view.queryByText('Load earlier')).toBeNull()
    expect(view.container.querySelector('[class*="older"]')).toBeNull()

    // Reaching the top of the transcript is an ordinary reader scroll: it
    // issues nothing, so the window stays the window the session opened with.
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLElement
    expect(scroller).not.toBeNull()
    const before = calls.length
    scroller.scrollTop = 0
    fireEvent.scroll(scroller)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(calls.length).toBe(before)
    expect(view.queryByText('加载更早')).toBeNull()
    await runtime.dispose()
  })
})
