// @vitest-environment jsdom
// ConversationRoot skeleton behavior: the ONE resident composer across an
// empty conversation and an active one — same textarea DOM node, machine-owned
// draft, and the household mark above it while there are no messages.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, EMPTY_CHAT_SNAPSHOT, EMPTY_CONVERSATION_VIEWS,
} from '@deepseek-ai/dsh-client-runtime/client'
import type {
  ConversationSnapshot, SessionId, SessionListState, WorkspaceId, WorkspaceListState, WorkspaceView,
} from '@deepseek-ai/dsh-client-runtime/client'
import type { ConversationRootProps } from '../src/client/skeleton/ConversationRoot.tsx'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'
import { zh } from '../src/client/locales.ts'
import { ConversationRoot } from '../src/client/skeleton/ConversationRoot.tsx'
import { ConversationSession, ConversationSessionHeader } from '../src/client/skeleton/ConversationSession.tsx'
import { InputBar } from '../src/client/skeleton/InputBar.tsx'
import type { InputBarProps } from '../src/client/skeleton/InputBar.tsx'
import type {
  ComposerBarOwnerProps,
} from '../src/client/contract/slots.ts'
import type { ViewTab } from '../src/client/contract/views.ts'

/** Machine-backed wiring over a sink spy. */
function fakeWiring() {
  const sink = vi.fn(() => Promise.resolve({ kind: 'success' as const }))
  const shell = new SessionInputShell({ actx: {} as ClientContext, defaultSink: sink, commandImages: { serialize: () => Promise.resolve([]), release: () => {}, unsupportedNotice: (token: string) => `${token.trim()} images-unsupported` } })
  return { wiring: shell, sink, shell }
}

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

// Mirrors the real lookup chain (conversation namespace, then common).
const t: ConversationRootProps['t'] = makeTranslate(zh, commonZh)

const sid = (id: string) => id as SessionId
const wid = (id: string) => id as WorkspaceId
const SID = sid('s1')

function workspace(id = 'w1'): WorkspaceView {
  return {
    workspaceId: wid(id), path: `/projects/${id}`, title: id, sessionIds: [],
    createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  }
}

const workspaceState = (items: readonly WorkspaceView[]): WorkspaceListState => ({
  items, archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  baselinesReady: true, recentWorkspaceId: undefined,
})

function conversationSnapshot(overrides: Partial<ConversationSnapshot> = {}): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: EMPTY_CHAT_SNAPSHOT,
    nodes: [], turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], running: false, composerPhase: 'active', removed: false,
    openState: 'open', openError: null, hasMore: false, loadingOlder: false,
    promptError: null, blank: false, subagent: null, lastAgentError: null,
    ...overrides,
  }
}

function mount(
  snapshot: ConversationSnapshot,
  workspaceRows: WorkspaceView[] = [{ ...workspace('one'), sessionIds: [SID] }],
  options: {
    /** When true, mimic overlay:true chain siblings (hidden fallback + takeover). */
    overlayTakeover?: boolean
    /** The session list summary's `blank` flag — independent of the snapshot's. */
    summaryBlank?: boolean
    /** Drop the session's summary row entirely (a session the list has not caught up with). */
    omitSummaryRow?: boolean
    /** Classify the selected child as a subagent instead of an ordinary fork. */
    summaryOrigin?: 'subagent'
    /** A composer block another plugin raised for this session. */
    composerBlock?: { reason: string }
    /** Mutable view ledger used by registration-order regressions. */
    viewTabs?: ViewTab[]
  } = {},
) {
  const root = sid('root')
  const rootRow = { id: root, displayTitle: 'Root', running: false, blank: false, updatedAt: 1 }
  const childRow = {
    id: SID, displayTitle: 'Child', parentId: root, cwd: '/projects/one',
    running: false, blank: options.summaryBlank ?? false, updatedAt: 2,
    ...(options.summaryOrigin === undefined ? {} : { origin: options.summaryOrigin }),
  }
  const listed = options.omitSummaryRow !== true
  const sessions = createSnapshotStore<SessionListState>({
    ids: listed ? [root, SID] : [root],
    byId: { [root]: rootRow, ...listed && { [SID]: childRow } },
    current: SID,
    phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined,
  })
  const workspaces = createSnapshotStore<WorkspaceListState>(workspaceState(workspaceRows))
  const session = createSnapshotStore<ConversationSnapshot>(snapshot)
  const useSession = bindSnapshotSelector(session)
  const chat = createChatStore().create()
  chat.actions.setDraft('ordinary draft')
  const { wiring, sink } = fakeWiring()
  const useInput = bindSnapshotSelector(wiring.state)
  const inputActions = wiring.actions
  const stop = vi.fn()
  const open = vi.fn()
  const slotCalls: string[] = []
  const viewTabs = options.viewTabs ?? [
    { id: 'chat', label: 'Chat' },
    { id: 'trajectory', label: 'Trajectory' },
  ]
  const views = {
    list: () => viewTabs,
    subscribe: () => () => {},
    version: () => 1,
  }
  /** Owner share handed to the two composer tool-row seats, per render. */
  const seatOwners: { key: string; owner: unknown }[] = []
  const renderSlot = ((key: string, owner: object, opts?: { only?: string }) => {
    slotCalls.push(key)
    if (key === 'conversation.input.model' || key === 'conversation.input.plan') {
      seatOwners.push({ key, owner })
    }
    if (key === 'conversation.session.header') {
      return (
        <ConversationSessionHeader
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          useStore={bindSnapshotSelector(chat)}
          actions={chat.actions}
          renderSlot={renderSlot as never}
          views={views}
          open={open}
          t={t}
        />
      )
    }
    if (key === 'conversation.session') {
      return (
        <ConversationSession
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          useStore={bindSnapshotSelector(chat)}
          actions={chat.actions}
          renderSlot={renderSlot as never}
          views={views}
          releaseSessionImages={vi.fn()}
          bindDraftMirror={write => wiring.bindMirror(write)}
        />
      )
    }
    if (key === 'conversation.composer.bar') {
      // The real entry, mounted the way the outlet composes it: standard kit
      // (shared with the root's props below) + this entry's inject + owner.
      const bar = owner as ComposerBarOwnerProps
      return (
        <InputBar
          sessionId={SID}
          SessionProvider={({ children }) => children(SID)}
          useSession={useSession}
          useSessions={props.useSessions}
          useWorkspaces={props.useWorkspaces}
          useProjection={(() => undefined)}
          useInput={useInput}
          inputActions={inputActions}
          keyboard={wiring}
          addImages={() => null}
          removeImage={() => {}}
          draftImages={() => []}
          resolveSubmitMode={() => 'queue'}
          toggleCommandMenu={vi.fn()}
          useNotices={bindSnapshotSelector(wiring.notices)}
          useLexicon={bindSnapshotSelector(wiring.lexicon)}
          useMenuLauncher={bindSnapshotSelector(createSnapshotStore<string | null>(null))}
          stop={stop}
          t={t}
          renderSlot={((key: string, seatOwner: object) => {
            // The bar's own seats: recorded so a case can assert what share
            // each tool-row control received.
            seatOwners.push({ key, owner: seatOwner })
            return null
          }) as InputBarProps['renderSlot']}
          {...bar}
        />
      )
    }
    return <div data-testid={`view-${opts?.only ?? key}`} />
  }) as ConversationRootProps['renderSlot']
  const renderSlotChain = ((_key, _owner, opts) => (
    options.overlayTakeover === true
      ? (
        <>
          <div data-chain-overlay-fallback="conversation.composer" style={{ display: 'none' }}>
            {opts?.fallback ?? null}
          </div>
          <div data-testid="composer-takeover">TAKEOVER</div>
        </>
      )
      : (opts?.fallback ?? null)
  )) as ConversationRootProps['renderSlotChain']
  const props: ConversationRootProps = {
    sessionId: SID,
    SessionProvider: ({ children }) => children(SID),
    useSession,
    useSessions: bindSnapshotSelector(sessions),
    useWorkspaces: bindSnapshotSelector(workspaces),
    useProjection: (() => undefined),
    useComposerBlock: select => select(options.composerBlock),
    useInput,
    inputActions,
    renderSlot,
    renderSlotChain,
    t,
  }
  const view = render(<ConversationRoot {...props} />)
  return {
    view, chat, sink, session, slotCalls, seatOwners, open,
    rerender: () => { view.rerender(<ConversationRoot {...props} />) },
  }
}

describe('ConversationRoot resident composer', () => {
  it('renders the composer inert with the blocker\u2019s own reason', () => {
    const b = mount(conversationSnapshot(), undefined, {
      composerBlock: { reason: 'select a model first' },
    })
    const box = b.view.getByRole('textbox') as HTMLTextAreaElement
    // One disabled textarea with the blocker's placeholder, never a second
    // tree: the DOM survives the block being raised and cleared.
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('select a model first')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.sink).not.toHaveBeenCalled()

    // The model seat stays live. Locking it too would leave the composer
    // asking for the one thing it prevents — every block this contract has is
    // cleared by choosing a model.
    const seat = (key: string) => b.seatOwners.filter(call => call.key === key).at(-1)?.owner
    expect(seat('conversation.input.model')).toEqual({ locked: false })
    expect(seat('conversation.input.plan')).toEqual({ locked: true })
  })

  it('a raised block owns the placeholder once a session exists, and keeps the model seat live', () => {
    // With a conversation open, the block's own reason IS the next step (the
    // model seat clears it). Only a session-less pane outranks it, and that
    // posture is covered where the pane actually has no session.
    const b = mount(conversationSnapshot({ composerPhase: 'blank' }), [], {
      summaryBlank: true,
      composerBlock: { reason: 'select a model first' },
    })
    const box = b.view.getByRole('textbox') as HTMLTextAreaElement
    expect(box.disabled).toBe(true)
    expect(box.placeholder).toBe('select a model first')
    // Blocked, not a workspace trigger: no menu semantics on the bar.
    expect(box.getAttribute('aria-haspopup')).toBeNull()
    const modelSeat = b.seatOwners.filter(call => call.key === 'conversation.input.model').at(-1)?.owner
    expect(modelSeat).toEqual({ locked: false })
  })

  it('keeps composer text in the machine, mirrors to the chat store, and submits through the sink', () => {
    const b = mount(conversationSnapshot())
    const box = b.view.getByRole('textbox')
    expect((box as HTMLTextAreaElement).value).toBe('ordinary draft')
    fireEvent.change(box, { target: { value: 'ordinary revised' } })
    expect(b.chat.store.getSnapshot().draft).toBe('ordinary revised')
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(b.sink).toHaveBeenCalledWith('ordinary revised', [], 'queue', expect.any(AbortSignal))
    expect(b.view.queryByRole('button', { name: 'Child' })).toBeNull()
    expect(b.view.queryByText('Root')).toBeNull()
  })

  it('shows hierarchy only for subagents and opens their ordinary owner', () => {
    const b = mount(conversationSnapshot(), undefined, { summaryOrigin: 'subagent' })
    const root = b.view.getByRole('button', { name: 'Root' })
    expect((b.view.getByRole('button', { name: 'Child' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(root)
    expect(b.open).toHaveBeenCalledWith(sid('root'))
  })

  it('subagent views have no composer, interaction takeover, or header editing controls', () => {
    const b = mount(conversationSnapshot(), undefined, { summaryOrigin: 'subagent', overlayTakeover: true })
    expect(b.view.queryByRole('textbox')).toBeNull()
    expect(b.view.container.querySelector('[data-composer-seat]')).toBeNull()
    expect(b.view.queryByTestId('composer-takeover')).toBeNull()
    expect(b.slotCalls).not.toContain('conversation.session.header.actions')
    expect(b.slotCalls).not.toContain('conversation.session.header.mode')
    expect(b.view.getByRole('button', { name: 'Root' })).toBeDefined()
    expect(b.sink).not.toHaveBeenCalled()
  })

  it('active phase: fixed header outside the scrollport; sticky composer seat inside it', () => {
    const b = mount(conversationSnapshot())
    const host = b.view.container.querySelector('[data-conversation-scroll]')
    const seat = b.view.container.querySelector('[data-composer-seat]')
    const header = b.view.container.querySelector('header')
    const textarea = b.view.container.querySelector('textarea')
    expect(host).not.toBeNull()
    expect(seat).not.toBeNull()
    expect(header).toBeNull()
    // Persistent inboxes have no title bar; the composer stays in the scrollport.
    expect(host?.contains(seat)).toBe(true)
    expect(seat?.contains(textarea)).toBe(true)
    expect(b.slotCalls).not.toContain('conversation.session.header.actions')
    expect(b.slotCalls).not.toContain('conversation.session.header.utilities')
    expect(b.slotCalls).not.toContain('conversation.composer.dock')
  })

  it('sticky composer seat wraps the whole overlay chain, not only the fallback stack', () => {
    const b = mount(conversationSnapshot(), undefined, { overlayTakeover: true })
    const seat = b.view.container.querySelector('[data-composer-seat]')
    const takeover = b.view.getByTestId('composer-takeover')
    const fallback = b.view.container.querySelector('[data-chain-overlay-fallback="conversation.composer"]')
    expect(seat?.contains(takeover)).toBe(true)
    expect(seat?.contains(fallback)).toBe(true)
  })

  it('empty conversation: the household mark above the docked composer, no headline chrome', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true }))
    // The mark, not a view ring: the placeholder is the whole conversation body
    // until a message arrives.
    const host = b.view.container.querySelector('[data-conversation-scroll]')
    const header = b.view.container.querySelector('header')
    const placeholder = b.view.getByTestId('conversation-empty')
    expect(host).not.toBeNull()
    expect(header).toBeNull()
    expect(host?.contains(placeholder)).toBe(true)
    expect(b.view.queryByTestId('view-chat')).toBeNull()
    // The mark is the welcome screen's own art: one masked box plus the glow,
    // never a second copy of the artwork.
    expect(placeholder.querySelector('svg')).not.toBeNull()
    expect(placeholder.querySelectorAll('div')).toHaveLength(1)
    // The deleted hero chrome stays deleted.
    expect(b.view.queryByText('探索未至之境')).toBeNull()
    expect(b.view.queryByText('预览版')).toBeNull()
    expect(b.view.queryByText('Into the Unknown')).toBeNull()
    expect(b.view.queryByText('Preview')).toBeNull()
    // Docking: the placeholder and the composer seat are siblings inside the
    // conversation body, and the root reports the active phase — the same
    // layout an active chat uses, so the first message moves nothing.
    const seat = b.view.container.querySelector('[data-composer-seat]')
    expect(seat?.parentElement).toBe(host)
    expect(placeholder.parentElement).toBe(host)
    expect(b.view.container.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('active')
    // The bar keeps its ordinary placeholder: a blank conversation supplies no
    // empty-state override any more.
    const box = b.view.getByRole('textbox') as HTMLTextAreaElement
    expect(host?.contains(box)).toBe(true)
    expect(box.placeholder).toBe('给智能体发消息')
    // The same machine-backed textarea is live, and the persistence mirror
    // stays bound (ConversationSession mounts chrome-hidden for blank
    // sessions): typing reaches the chat store.
    fireEvent.change(box, { target: { value: 'draft in the empty conversation' } })
    expect(b.chat.store.getSnapshot().draft).toBe('draft in the empty conversation')
  })

  it('settling phase: a summary that does not prove the session blank hides the composer while it opens', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true, openState: 'loading' }))
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('settling')
    // The placeholder is withheld too: the session may still turn out to hold
    // a transcript, and art that flashes then vanishes reads as a reload.
    expect(b.view.queryByTestId('conversation-empty')).toBeNull()
  })

  it('settling phase: a session the list has no row for settles conservatively', () => {
    const b = mount(
      conversationSnapshot({ composerPhase: 'blank', blank: true, openState: 'loading' }),
      undefined,
      { omitSummaryRow: true },
    )
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('settling')
  })

  it('a conversation whose emptiness is unproven never claims there are no messages', () => {
    // `cold` (never opened) and `error` (the history request failed) both leave
    // the column without a transcript we have read. The branded mark says "no
    // messages", so it must stay out of that body exactly as the deleted hero
    // chrome did — otherwise a history failure is decorated as an empty
    // conversation. The snapshot keeps `blank: false` here so the session body
    // is really mounted (in the assembled app ChatView paints its
    // `chat.loadError` row into it) and the assertion is about a decorated
    // surface rather than about a null body.
    for (const openState of ['cold', 'error'] as const) {
      const b = mount(
        conversationSnapshot({ composerPhase: 'blank', blank: false, openState }),
        undefined,
        { omitSummaryRow: true },
      )
      expect(b.view.queryByTestId('conversation-empty'), openState).toBeNull()
      expect(b.view.getByTestId('view-chat'), openState).toBeTruthy()
      expect(b.view.getByRole('textbox'), openState).toBeTruthy()
      b.view.unmount()
    }
  })

  it('a failed open still shows the mark once the summary proves the session blank', () => {
    // The same proof that exempts a session from settling: there is no history
    // to read, so the failure cannot have hidden one.
    const b = mount(
      conversationSnapshot({ composerPhase: 'blank', blank: true, openState: 'error' }),
      undefined,
      { summaryBlank: true },
    )
    expect(b.view.getByTestId('conversation-empty')).toBeTruthy()
    expect(b.view.container.querySelector('[data-phase]')?.getAttribute('data-phase')).toBe('active')
  })

  it('startup auto-selection: a summary-proven blank session opens straight into the placeholder', () => {
    const b = mount(
      conversationSnapshot({ composerPhase: 'blank', blank: true, openState: 'loading' }),
      undefined,
      { summaryBlank: true },
    )
    // The summary already proves the outcome, so the settling hide would only
    // blank the column for the history round-trip.
    const root = b.view.container.querySelector('[data-phase]')
    expect(root?.getAttribute('data-phase')).toBe('active')
    expect(b.view.getByTestId('conversation-empty')).toBeTruthy()
    expect(b.view.getByRole('textbox')).toBeTruthy()
  })

  it('same textarea DOM node survives the empty → active flip inside the sticky scrollport', () => {
    const b = mount(conversationSnapshot({ composerPhase: 'blank', blank: true }))
    const before = b.view.getByRole('textbox')
    const placeholder = b.view.getByTestId('conversation-empty')
    fireEvent.change(before, { target: { value: 'kept across flip' } })
    // First message landed: content exists, phase leaves blank. Composer
    // already sat in the resident scrollport, so the textarea node and the
    // InputHub draft both survive, and the placeholder art makes way for the
    // transcript at the same seat.
    b.session.set(conversationSnapshot({ composerPhase: 'active', blank: false }))
    b.rerender()
    const after = b.view.getByRole('textbox') as HTMLTextAreaElement
    expect(after).toBe(before)
    expect(after.value).toBe('kept across flip')
    expect(b.chat.store.getSnapshot().draft).toBe('kept across flip')
    expect(b.view.container.querySelector('[data-conversation-scroll]')?.contains(after)).toBe(true)
    expect(b.view.queryByTestId('conversation-empty')).toBeNull()
    expect(b.view.getByTestId('view-chat')).toBeTruthy()
    expect(placeholder.isConnected).toBe(false)
  })

  it('keeps pending takeover interaction accessible outside the Chat view', () => {
    const b = mount(conversationSnapshot({ pending: [{} as never] }))
    act(() => { b.chat.actions.setView('trajectory') })
    expect(b.view.getByTestId('view-trajectory')).toBeTruthy()
    expect(b.view.getByRole('textbox')).toBeTruthy()
  })

  it('keeps the Chat fallback selected by id when a view is inserted before it', () => {
    const viewTabs: ViewTab[] = [
      { id: 'chat', label: 'Chat' },
      { id: 'trajectory', label: 'Trajectory' },
    ]
    const b = mount(conversationSnapshot(), undefined, { viewTabs })
    // A removed dynamic view leaves its persisted id behind. The visible
    // fallback is Chat and must stay Chat when another lower-order view lands.
    act(() => { b.chat.actions.setView('removed-view') })
    expect(b.view.getByTestId('view-chat')).toBeTruthy()

    viewTabs.unshift({ id: 'new-view', label: 'New view' })
    b.rerender()

    expect(b.view.getByTestId('view-chat')).toBeTruthy()
    expect(b.view.queryByTestId('view-new-view')).toBeNull()
    expect(b.view.queryByRole('tablist')).toBeNull()
  })

  it('prompt failure renders the promptError strip (ordinary failure, no transaction UI)', () => {
    const b = mount(conversationSnapshot({
      promptError: { op: 'send', error: { code: 'offline', message: 'Message send failed' } as never },
    }))
    expect(b.view.getByRole('alert').textContent).toContain('Message send failed (offline)')
    expect(b.view.queryByRole('button', { name: 'Retry' })).toBeNull()
  })
})
