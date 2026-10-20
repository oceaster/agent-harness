// @vitest-environment jsdom
// ChatView behavior: flow derivation, streaming isolation (Profiler counts),
// Tool seat ownership and selection handoff — driven through a scripted
// ObservableSnapshot fake, no wire or Tool presentation plugin.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useEffect } from 'react'
import type {
  AssistantMessageNode, CommandNode, CompactionSummaryNode, ConversationNode, ConversationSnapshot,
  ModelRetryNode, RunningToolCall, SessionId, SessionListState, SessionReaction, ToolCallBlock, ToolResultNode,
  TurnErrorNode, TurnMaxTokensNode, UserMessageNode, WorkspaceListState,
} from '@deepseek-ai/dsh-client-runtime/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import {
  createSnapshotStore, EMPTY_CONVERSATION_VIEWS, PendingWait,
} from '@deepseek-ai/dsh-client-runtime/client'
import { RpcId } from '@deepseek-ai/dsh-client-connection/client'
import type {
  ChatNode, ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps, SelectionTarget,
  SessionReactionAction, UseChatNodeReaction, UseChatNodeTurnData,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createChatStore } from '../src/client/stores.ts'
import { ChatView } from '../src/client/chat/ChatView.tsx'
import { en, zh } from '../src/client/locales.ts'
import { AssistantNodeView } from '../src/client/chat/AssistantNodeView.tsx'
import { CommandNodeView, ManualCompactionNodeView } from '../src/client/chat/CommandNodeView.tsx'
import {
  CompactionNodeView, ContextMessageNodeView, RetryNodeView, TurnErrorNodeView,
  TurnMaxTokensNodeView, UnknownNodeView, UserMessageNodeView,
} from '../src/client/chat/MessageItem.tsx'
import { TurnTailNodeView } from '../src/client/chat/TurnTailNodeView.tsx'
import { formatRunDuration } from '../src/client/chat/message-chrome.ts'
import { chatSnapshotFixture } from './chat-snapshot-fixture.client.ts'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
// Keyless create() persists under the bare declared key; clear between cases
// so one harness's selection cannot rehydrate into the next.
beforeEach(() => {
  localStorage.clear()
})

const SID = 's1' as SessionId
type RoutedChatNodeOwner = ChatNodeOwnerProps & { readonly node: ChatNode }

function snapshotBase(): ConversationSnapshot {
  return {
    sessionId: SID, views: EMPTY_CONVERSATION_VIEWS, chat: chatSnapshotFixture(), nodes: [],
    turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [],
    pending: [], queue: [], reactions: new Map(), running: false, composerPhase: 'active',
    removed: false, openState: 'open', openError: null,
    hasMore: false, loadingOlder: false, promptError: null, blank: false, subagent: null, lastAgentError: null,
  }
}

/** Scripted snapshot source: set() swaps the top-level object like the real Session. */
function makeSource(init?: Partial<ConversationSnapshot>) {
  const initial = { ...snapshotBase(), ...init }
  let snap: ConversationSnapshot = {
    ...initial,
    chat: init?.chat ?? chatSnapshotFixture(initial),
  }
  const subs = new Set<() => void>()
  return {
    set: (next: Partial<ConversationSnapshot>) => {
      const merged = { ...snap, ...next }
      snap = {
        ...merged,
        chat: Object.hasOwn(next, 'chat') && next.chat !== undefined
          ? next.chat
          : chatSnapshotFixture(merged, snap.chat),
      }
      for (const fn of [...subs]) fn()
    },
    source: {
      getSnapshot: () => snap,
      subscribe: (fn: () => void) => {
        subs.add(fn)
        return () => subs.delete(fn)
      },
    },
  }
}

const user = (seq: number, text: string): UserMessageNode => ({
  kind: 'user',
  seq,
  time: seq * 1000,
  content: [{ type: 'text', text }] as never,
  source: null,
})
const assistant = (seq: number, text: string, turn = 1): AssistantMessageNode => ({
  kind: 'assistant', seq, time: seq * 1_000, turn, step: 1, blocks: [{ kind: 'text', text }],
})
const retry = (seq: number): ModelRetryNode => ({
  kind: 'model-retry', retryId: 'chat-view-retry' as ModelRetryNode['retryId'],
  seq, time: seq * 1_000, turn: 1, step: 0,
  retryState: 'scheduled',
  provider: 'mock', mode: 'normal', policyKey: 'mock-normal',
  retry: 1, maxRetries: 2, delayMs: 450,
  failure: { code: 'TRANSPORT', message: '连接被重置' },
})
const turnError = (seq: number, code?: string): TurnErrorNode => ({
  kind: 'turn-error', seq, time: seq * 1_000, turn: 1, step: 0,
  message: seq === 2 ? 'API key is invalid' : 'plugin exploded',
  ...(code === undefined ? {} : { code }),
})
const turnMaxTokens = (seq: number): TurnMaxTokensNode => ({
  kind: 'turn-max-tokens', seq, time: seq * 1_000, turn: 1, step: 0,
})
const toolResult = (seq: number, callId: string, name = 'bash'): ToolResultNode => ({
  kind: 'tool-result', seq, time: seq * 1_000, callId,
  call: { name, argsRaw: `{"command":"cmd-${callId}","description":"run ${callId}"}` },
  callTime: seq * 1_000 - 500,
  content: [], isError: false, callView: null, resultView: null, subCalls: [],
})
const runningCall = (callId: string, name = 'bash'): RunningToolCall => ({
  callId, name, argsRaw: `{"command":"cmd-${callId}"}`, turn: 2, step: 1, time: 1_000, callView: null, subCalls: [],
})
const command = (over: Partial<CommandNode> = {}): CommandNode => ({
  kind: 'command', seq: 5, time: 5_000, commandId: 'cmd-1' as CommandNode['commandId'],
  name: 'plan', args: '', outcome: { kind: 'success', text: '已进入 plan mode' },
  ...over,
})
const compaction = (over: Partial<CompactionSummaryNode> = {}): CompactionSummaryNode => ({
  kind: 'compaction', seq: 8, time: 8_000,
  summary: '## 压缩摘要\n\n保留的事实。',
  summaryEventSeq: 7,
  shadowedItemCount: 16,
  shadowedTokenCount: 11_309,
  ...over,
})

/** Empty sessions-list hook for the global standard-kit seat. */
function emptySessions() {
  const store = createSnapshotStore<SessionListState>(
    { ids: [], byId: {}, current: undefined, phase: 'ready', subagentsByParent: {}, jobsBySession: {}, currentAddress: undefined })
  return bindSnapshotSelector(store)
}

function emptyWorkspaces() {
  const store = createSnapshotStore<WorkspaceListState>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
    baselinesReady: true, recentWorkspaceId: undefined,
  })
  return bindSnapshotSelector(store)
}

/**
 * Session-list hooks carrying one row for this chat's session, composed from
 * `agentPreset`. Omitting it is a session row with no preset at all.
 * @param agentPreset - the preset id the host records on the session.
 * @returns the standard-kit sessions hook.
 */
function sessionsWith(agentPreset?: string) {
  const store = createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: {
      [SID]: {
        id: SID, displayTitle: 's1', running: true, blank: false, updatedAt: 0,
        ...(agentPreset === undefined ? {} : { agentPreset }),
      },
    },
    current: SID,
    phase: 'ready',
    subagentsByParent: {},
    jobsBySession: {},
    currentAddress: undefined,
  })
  return bindSnapshotSelector(store)
}

/**
 * The verb the running-turn status shows, with its aria-hidden clock excluded.
 * @param view - the rendered chat view.
 * @returns the status line's leading text.
 */
function statusVerb(view: ReturnType<typeof render>): string | null {
  return view.getByRole('status').firstChild?.textContent ?? null
}

function makeHarness(init?: Partial<ConversationSnapshot>) {
  const { set, source } = makeSource(init)
  const openDetails = vi.fn<(t: SelectionTarget) => void>()
  const openFile = vi.fn<(path: string) => Promise<void>>().mockResolvedValue(undefined)
  const inspectCall = vi.fn<(callId: string) => void>()
  // In-memory scroll memory matching the apply.ts per-session map contract.
  let savedScroll: ReturnType<ChatViewSlotProps['chatScroll']['read']> = null
  const chatScroll: ChatViewSlotProps['chatScroll'] = {
    save: (position) => { savedScroll = position },
    read: () => savedScroll,
  }
  // Selection rides the REAL chat store (same construction path as
  // production; the view reads it through the PropsStore useStore share).
  const chat = createChatStore().create()
  const t = makeTranslate(zh, commonZh)
  const toolOwners: Array<{
    callId: string
    toolName: string
    block: ToolCallBlock
    selectedCallId: string | undefined
    openFile: ChatNodeOwnerProps['openFile']
    inspectCall: ChatNodeOwnerProps['inspectCall']
  }> = []
  // The reaction note writer every row shares: resolving by default, so a test
  // that cares only about the badge never has to stub it.
  const reactSpy = vi.fn<(emoji: string, action: SessionReactionAction) => Promise<void>>()
    .mockResolvedValue(undefined)
  const renderCommandSlot = ((_key: string, _owner: object, opts?: { fallback?: React.ReactNode }) =>
    opts?.fallback ?? null) as unknown as React.ComponentProps<typeof CommandNodeView>['renderSlot']
  const renderTurnTail = ((_key: string, _owner: object) => null) as unknown as
    React.ComponentProps<typeof TurnTailNodeView>['renderSlotChain']
  const renderTurnTailSlot = (() => null) as unknown as
    React.ComponentProps<typeof TurnTailNodeView>['renderSlot']
  const renderSlot = ((key: string, owner: object, opts?: {
    fallback?: React.ReactNode
    hookContext?: unknown
  }) => {
    if (key !== 'conversation.chat.node') return opts?.fallback ?? null
    const nodeOwner = owner as RoutedChatNodeOwner
    const nodeKey = opts?.hookContext as string | undefined
    const useTurnData: UseChatNodeTurnData = dataKey => props.useSession((snapshot) => {
      const location = nodeKey === undefined ? undefined : snapshot.chat.nodes.get(nodeKey)?.location
      return location?.kind === 'turn' || location?.kind === 'step'
        ? location.turn.data.get(dataKey)
        : undefined
    })
    // The reaction face wired exactly as apply.ts wires it: the badge is the
    // log's own fold off the snapshot, and the writer is the fire-and-forget
    // note call (spied, so a test can assert the wire arguments).
    const useReaction: UseChatNodeReaction = targetSeq => ({
      reaction: props.useSession(snapshot =>
        targetSeq === undefined ? undefined : snapshot.reactions.get(targetSeq)),
      react: reactSpy,
    })
    const nodeProps = <Kind extends ChatNode['kind']>(): ChatNodeViewProps<Kind> => (
      { ...props, ...nodeOwner, useTurnData, useReaction } as unknown as ChatNodeViewProps<Kind>
    )
    switch (nodeOwner.node.kind) {
      case 'user':
      case 'steering':
        return <UserMessageNodeView {...nodeProps<'user' | 'steering'>()} />
      case 'context':
        return <ContextMessageNodeView {...nodeProps<'context'>()} />
      case 'assistant-step':
        return <AssistantNodeView {...nodeProps<'assistant-step'>()} />
      case 'command':
        return (
          <CommandNodeView
            {...nodeProps<'command'>()}
            renderSlot={renderCommandSlot}
            SessionProvider={props.SessionProvider}
          />
        )
      case 'manual-compaction':
        return <ManualCompactionNodeView {...nodeProps<'manual-compaction'>()} />
      case 'compaction':
        return <CompactionNodeView {...nodeProps<'compaction'>()} />
      case 'model-retry':
        return <RetryNodeView {...nodeProps<'model-retry'>()} />
      case 'turn-error':
        return <TurnErrorNodeView {...nodeProps<'turn-error'>()} />
      case 'turn-max-tokens':
        return <TurnMaxTokensNodeView {...nodeProps<'turn-max-tokens'>()} />
      case 'turn-tail':
        return (
          <TurnTailNodeView
            {...nodeProps<'turn-tail'>()}
            renderSlot={renderTurnTailSlot}
            renderSlotChain={renderTurnTail}
            SessionProvider={props.SessionProvider}
          />
        )
      case 'unknown':
        return <UnknownNodeView {...nodeProps<'unknown'>()} />
      case 'tool-call': {
        const block = nodeOwner.node.data.root
        const toolName = 'kind' in block ? block.call?.name ?? '' : block.name
        const tool = {
          callId: block.callId,
          toolName,
          block,
          selectedCallId: nodeOwner.selectedCallId,
          openFile: nodeOwner.openFile,
          inspectCall: nodeOwner.inspectCall,
        }
        toolOwners.push(tool)
        return (
          <div
            data-testid={`tool-seat-${tool.callId}`}
            data-chat-anchor-key={`call:${tool.callId}`}
            data-chat-call-id={tool.callId}
          >
            {tool.toolName || '(unnamed)'}:{tool.callId}
          </div>
        )
      }
      default:
        return opts?.fallback ?? null
    }
  }) as unknown as ChatViewSlotProps['renderSlot']
  // SessionProvider seat arrives with the session-scope child declaration;
  // ChatView never invokes it (render-prop pass-through stub).
  const SessionProviderStub: ChatViewSlotProps['SessionProvider'] = ({ children }) => <>{children(SID)}</>
  const props: ChatViewSlotProps = {
    sessionId: SID,
    useSession: bindSnapshotSelector(source),
    useSessions: emptySessions(),
    useWorkspaces: emptyWorkspaces(),
    useProjection: (() => undefined),
    useInput: (() => { throw new Error('unused') }),
    inputActions: {
      setDraft: () => {},
      addImages: () => true,
      removeImage: () => {},
      pruneImages: () => {},
      submit: () => {},
    },
    useStore: bindSnapshotSelector(chat),
    actions: chat.actions,
    renderSlot,
    SessionProvider: SessionProviderStub,
    openDetails,
    openFile,
    loadImage: vi.fn(() => Promise.reject(new Error('not used'))),
    inspectCall,
    chatScroll,
    // Absent-service default; mention tests override with a real resolver.
    fileMentions: () => undefined,
    // Mirrors the real lookup chain (conversation namespace, then common).
    t,
  }
  const setSelection = (next: SelectionTarget | null): void => { chat.actions.select(next) }
  return {
    set, ChatView, props, openDetails, openFile, inspectCall,
    chatScroll, setSelection, toolOwners, reactSpy,
  }
}

/** Simulate reader input (any device): a delivered position that deviates
 * from the observed-top ledger of programmatic writes. */
function readerScroll(element: HTMLElement, top: number): void {
  element.scrollTop = top
  fireEvent.scroll(element)
}

function installScrollMetrics(element: HTMLElement, initialHeight: number, clientHeight: number) {
  let scrollHeight = initialHeight
  let scrollTop = 0
  Object.defineProperty(element, 'scrollHeight', { configurable: true, get: () => scrollHeight })
  Object.defineProperty(element, 'clientHeight', { configurable: true, get: () => clientHeight })
  Object.defineProperty(element, 'scrollTop', {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => { scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight)) },
  })
  return {
    setHeight: (value: number) => { scrollHeight = value },
    setLayout: (height: number, top: number) => {
      scrollHeight = height
      scrollTop = Math.max(0, Math.min(top, scrollHeight - clientHeight))
    },
  }
}

describe('Chat node rendering', () => {

  it('threads the injected file-mention vocabulary into the closing prose only', () => {
    const wrote = (seq: number, callId: string, path: string): ToolResultNode => ({
      ...toolResult(seq, callId, 'write'),
      callView: {
        card: 'diff', title: 'Write', diffs: [{ path, oldText: null, newText: 'x' }], locations: [{ path }],
      },
    })
    const h = makeHarness({
      nodes: [
        user(1, 'build it'),
        assistant(2, 'writing `report.html` now', 1),
        wrote(3, 'w', 'site/report.html'),
        assistant(4, 'Wrote `report.html`; `notes.md` untouched.', 1),
      ],
      turnEnds: new Map([[1, 4]]),
    })
    // Stub provider mirroring the real service: only produced files resolve.
    h.props.fileMentions = owner => ({
      resolve: (value) => {
        if (value !== 'report.html') return undefined
        return {
          open: () => { void h.openFile(`for-seq-${String(owner.seq)}/site/report.html`) },
          label: '打开 site/report.html',
          title: 'site/report.html',
        }
      },
    })
    const view = render(<h.ChatView {...h.props} />)
    // Exactly one live mention: the closing message links, the mid-turn
    // narration stays inert code, and the unknown file resolves to nothing.
    const mentions = view.container.querySelectorAll('code button')
    expect(mentions).toHaveLength(1)
    const mention = view.getByRole('button', { name: '打开 site/report.html' })
    expect(mention.getAttribute('title')).toBe('site/report.html')
    fireEvent.click(mention)
    // The vocabulary was built from the closing message's own owner currency.
    expect(h.openFile).toHaveBeenCalledWith('for-seq-4/site/report.html')
  })

  it('formatRunDuration localizes units and floors partial seconds', () => {
    const t = makeTranslate(zh, commonZh)
    expect(formatRunDuration(0, t)).toBe('0秒')
    expect(formatRunDuration(-500, t)).toBe('0秒')
    expect(formatRunDuration(15_999, t)).toBe('15秒')
    expect(formatRunDuration(125_000, t)).toBe('2分05秒')
  })

})

describe('ChatView', () => {
  it('hands a windowless tool result to the Tool seat with an empty tool name', () => {
    const h = makeHarness({
      nodes: [{ ...toolResult(3, 'w1'), call: null }],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('tool-seat-w1')).toBeTruthy()
    expect(h.toolOwners[0]).toMatchObject({ callId: 'w1', toolName: '' })
  })

  it('offers no control that asks for older messages, even when the client holds a partial window', () => {
    const h = makeHarness({ nodes: [user(9, 'first visible'), user(10, 'next visible')], hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    // The transcript is the window the session opened with: the tail page
    // reported older history outside it, and nothing in the view can ask for
    // that history. No paging row, no button, no busy label.
    expect(view.container.querySelector('[class*="older"]')).toBeNull()
    expect(view.queryByText('加载更早')).toBeNull()
    expect(view.queryByText('Load earlier')).toBeNull()
    expect(view.queryByText('加载中…')).toBeNull()
    // Every button the view does render belongs to a message or the composer
    // seat, never to history paging.
    const labels = [...view.container.querySelectorAll('button')]
      .map(button => `${button.textContent ?? ''}|${button.getAttribute('aria-label') ?? ''}`)
    expect(labels.some(label => /加载更早|Load earlier|加载中/.test(label))).toBe(false)
    // The flow opens on the window's own first row: no header row above it.
    const flow = view.container.querySelector('[data-chat-flow=""]') as HTMLElement
    expect(flow.firstElementChild?.textContent).toContain('first visible')
  })

  it('paints a reaction as a badge on its message and leaves the transcript text identical', () => {
    const h = makeHarness({
      nodes: [user(1, 'hello there'), assistant(2, 'hi back', 1)],
      turnEnds: new Map([[1, 2]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    const flow = (): HTMLElement => view.container.querySelector('[data-chat-flow=""]') as HTMLElement
    // The transcript's own words, with the badge — chrome on the row — taken
    // back out, so a badge can never hide a row of its own.
    const transcriptText = (): string => {
      const clone = flow().cloneNode(true) as HTMLElement
      for (const badge of clone.querySelectorAll('[data-reaction-badge]')) badge.remove()
      return clone.textContent ?? ''
    }
    const rowsBefore = flow().children.length
    const textBefore = transcriptText()
    // Both durable messages offer the affordance; nothing is recorded yet.
    expect(view.getAllByRole('button', { name: zh['reaction.button'] }).length).toBeGreaterThanOrEqual(2)
    expect(view.container.querySelector('[data-reaction-badge]')).toBeNull()
    // The note comes back in the log, folded by the message it targets.
    const reaction: SessionReaction = {
      targetSeq: 1, emoji: '👍', action: 'added', actor: 'user', seq: 99,
    }
    act(() => {
      h.set({ reactions: new Map([[1, reaction]]) })
    })
    // The badge is the only difference: same rows, same words, no reaction row,
    // bubble, divider, timestamp or system line anywhere in the transcript.
    expect(view.container.querySelector('[data-reaction-badge]')?.textContent).toBe('👍')
    expect(flow().children.length).toBe(rowsBefore)
    expect(transcriptText()).toBe(textBefore)
    expect(view.queryByText(/reacted/u)).toBeNull()
    expect(view.queryByText(/反应|回应了/u)).toBeNull()
  })

  it('renders the recent window only, starting at the oldest message the client holds', () => {
    // A 50-message window out of a session with more history before it.
    const windowNodes = Array.from({ length: 50 }, (_, index) => (
      index % 2 === 0
        ? user(101 + index, `window message ${101 + index}`)
        : assistant(101 + index, `window reply ${101 + index}`)
    ))
    const h = makeHarness({ nodes: windowNodes, hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const rows = [...view.container.querySelectorAll('[data-chat-flow-key]')]
    expect(rows).toHaveLength(50)
    // The oldest rendered message is the window boundary itself, not a
    // synthesized gap row and not a message the client never fetched.
    expect(rows[0]?.textContent).toContain('window message 101')
    expect(view.container.textContent).not.toContain('window message 100')
    expect(rows.at(-1)?.textContent).toContain('window reply 150')
  })

  it('scrolling to the top of the window asks for nothing and keeps the window as it is', () => {
    const windowNodes = Array.from({ length: 30 }, (_, index) => user(201 + index, `row ${201 + index}`))
    const h = makeHarness({ nodes: windowNodes, hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 3_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, writable: true })
    // A reader leaves the floor (which disarms follow), then keeps going to
    // the very top of what the client holds.
    readerScroll(scroller, 100)
    expect(scroller.scrollTop).toBe(100)
    readerScroll(scroller, 0)
    // Nothing is issued by reaching the top: no busy label, no paging row, no
    // extra row — the transcript is the window it opened with.
    expect(view.queryByText('加载中…')).toBeNull()
    expect(view.container.querySelector('[class*="older"]')).toBeNull()
    expect(view.container.querySelectorAll('[data-chat-flow-key]')).toHaveLength(30)
    expect(scroller.scrollTop).toBe(0)
  })

  it('renders the fixture main line as independently keyed business nodes', () => {
    const h = makeHarness({
      nodes: [user(1, 'do the thing'), assistant(2, 'running tools'), toolResult(3, 'a'), toolResult(4, 'b')],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('do the thing')).toBeTruthy()
    expect(view.getByText('running tools')).toBeTruthy()
    expect(view.getByTestId('tool-seat-a').textContent).toBe('bash:a')
    expect(view.getByTestId('tool-seat-b').textContent).toBe('bash:b')
    expect([...view.container.querySelectorAll('[data-chat-flow-key]')].map(row => ({
      key: row.getAttribute('data-chat-flow-key'),
      kind: row.getAttribute('data-chat-flow-kind'),
    }))).toEqual([
      { key: 'fixture:user:1', kind: 'user' },
      { key: 'fixture:assistant:2', kind: 'assistant-step' },
      { key: 'fixture:tool:a', kind: 'tool-call' },
      { key: 'fixture:tool:b', kind: 'tool-call' },
    ])
    expect([...view.container.querySelectorAll('[data-chat-call-id]')].map(row => row.getAttribute('data-chat-call-id')))
      .toEqual(['a', 'b'])
    expect([...view.container.querySelectorAll('[data-chat-anchor-key]')].map(row => row.getAttribute('data-chat-anchor-key')))
      .toEqual([
        'fixture:user:1', 'fixture:assistant:2',
        'fixture:tool:a', 'call:a', 'fixture:tool:b', 'call:b',
      ])
  })

  it('renders Host-pending steering at the flow tail and hands off to the durable node', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    })
    const pending = {
      id: 'steer-occurrence' as never,
      messageId: 'steer-message' as never,
      placement: 'steering' as const,
      content: [{ type: 'text' as const, text: 'interrupt now' }],
      preview: 'interrupt now',
      text: 'interrupt now',
    }
    const queued = {
      id: 'queued-occurrence' as never,
      messageId: 'queued-message' as never,
      placement: 'queued' as const,
      content: [{ type: 'text' as const, text: 'later' }],
      preview: 'later',
      text: 'later',
    }
    const h = makeHarness({ nodes: [assistant(1, 'working')], queue: [queued, pending], running: true })
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getByText('interrupt now').closest('[data-pending-steering]')).not.toBeNull()
    expect(view.queryByText('later')).toBeNull()
    const pendingBubble = view.getByText('interrupt now').closest('[data-pending-steering]')
    expect(pendingBubble).not.toBeNull()
    fireEvent.click(within(pendingBubble as HTMLElement).getByRole('button', { name: '复制' }))
    expect(writeText).toHaveBeenCalledWith('interrupt now')
    expect(view.getByRole('status').compareDocumentPosition(view.getByText('interrupt now'))
      & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

    act(() => {
      h.set({
        queue: [queued],
        nodes: [
          assistant(1, 'working'),
          {
            kind: 'steering', messageId: pending.messageId,
            seq: 2, time: 2_000,
            content: [{ type: 'text', text: 'interrupt now' }], source: null,
          },
        ],
      })
    })
    expect(view.getAllByText('interrupt now')).toHaveLength(1)
    expect(view.container.querySelector('[data-pending-steering]')).toBeNull()
    // Only the durable steering bubble: the turn is still running, so its
    // assistant narration owns no footer yet.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(1)
    expect(view.container.querySelector('[data-turn-tail]')).toBeNull()

    act(() => {
      h.set({ running: false, turnEnds: new Map([[1, 3]]) })
    })
    // The Turn Tail belongs to the closed Turn, independently of a later
    // steering bubble's placement in the Chat list.
    expect(view.container.querySelectorAll('[data-turn-tail]')).toHaveLength(1)
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(2)
  })

  it('keeps a later pending occurrence visible when it reuses a durable MessageId', () => {
    const pending = {
      id: 'steer-occurrence-later' as never,
      messageId: 'shared-steer-message' as never,
      placement: 'steering' as const,
      content: [{ type: 'text' as const, text: 'same steering' }],
      preview: 'same steering',
      text: 'same steering',
    }
    const h = makeHarness({
      queue: [pending],
      nodes: [{
        kind: 'user', seq: 2, time: 2_000,
        content: pending.content, source: null,
      }],
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)

    expect(view.getAllByText('same steering')).toHaveLength(2)
    expect(view.container.querySelectorAll('[data-pending-steering]')).toHaveLength(1)
  })

  it('animates only the latest unresolved model retry', () => {
    const retryNode = retry(2)
    const nextRetry = { ...retry(3), turn: 2, retry: 2 }
    const context = {
      kind: 'context', seq: 4, time: 4_000, content: [], source: null,
      provenance: { role: 'inject', label: null },
      form: null,
    } as const satisfies ConversationNode
    const h = makeHarness({ nodes: [user(1, 'try'), retryNode], running: true })
    const view = render(<h.ChatView {...h.props} />)
    const disclosure = view.container.querySelector('details') as HTMLDetailsElement
    expect(disclosure.dataset.active).toBe('true')
    expect(within(disclosure).getByRole('status').textContent).toBe('正在重试模型请求（1/2） · 1s')

    act(() => {
      h.set({ nodes: [user(1, 'try'), nextRetry] })
    })
    expect(within(disclosure).getAllByRole('status')).toHaveLength(1)
    expect(view.container.querySelector('details')).toBe(disclosure)
    expect(within(disclosure).getByRole('status').textContent).toBe('正在重试模型请求（2/2） · 1s')

    act(() => {
      h.set({
        nodes: [
          user(1, 'try'),
          { ...nextRetry, retryState: 'started' },
          context,
          assistant(5, 'done'),
        ],
        running: false,
      })
    })
    expect(disclosure.dataset.active).toBeUndefined()
    expect(within(disclosure).getByRole('status').textContent).toBe('已重试模型请求（2/2） · 1s')

    act(() => {
      h.set({ nodes: [user(1, 'try'), { ...retry(6), retryState: 'cancelled' }], running: true })
    })
    const cancelledDisclosure = view.container.querySelector('details') as HTMLDetailsElement
    expect(cancelledDisclosure.dataset.active).toBeUndefined()
    expect(within(cancelledDisclosure).getByRole('status').textContent).toContain('重试已取消')
  })

  it('renders terminal turn failures inline with their durable message and optional code', () => {
    const h = makeHarness({ nodes: [user(1, 'try'), turnError(2, 'AUTH'), turnError(3)] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '本轮运行失败API key is invalidAUTH',
      '本轮运行失败plugin exploded',
    ])
  })

  it('replaces an unavailable agent diagnostic with one sentence to act on', () => {
    // The provider's own text carries a gateway cooldown countdown that reads as
    // a hard deadline ("recovers in 86227s"), and credit in practice returns in
    // minutes. The transcript says that plainly instead of quoting it.
    const h = makeHarness({
      nodes: [
        user(1, 'try'),
        { ...turnError(2, 'QUOTA'), message: 'DeepSeek unavailable — direct: no_credit, recovers in 86227s' },
        { ...turnError(3, 'SERVER'), message: 'DeepSeek upstream failure after 2 attempt(s): HTTP 502' },
      ],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getAllByRole('status').map(status => status.textContent)).toEqual([
      zh['message.turnError.unavailable'],
      zh['message.turnError.unavailable'],
    ])
    // Neither the raw provider text nor its machine code reaches the transcript.
    expect(view.queryByText(/no_credit/)).toBeNull()
    expect(view.queryByText(/recovers in/)).toBeNull()
    expect(view.queryByText('QUOTA')).toBeNull()
    expect(view.queryByText('SERVER')).toBeNull()
    expect(view.queryByText(zh['message.turnError'])).toBeNull()
  })

  it('renders the max-tokens notice with localized guidance, distinct from turn errors', () => {
    const h = makeHarness({ nodes: [user(1, 'try'), assistant(2, 'truncated'), turnMaxTokens(3)] })
    const view = render(<h.ChatView {...h.props} />)
    const statuses = view.getAllByRole('status')
    expect(statuses.map(status => status.textContent)).toEqual([
      '已达到输出 token 上限回答被截断，已有输出保留在对话中。发送“继续”可让模型接着输出。',
    ])
    expect(view.queryByText('本轮运行失败')).toBeNull()
  })

  it('hands the trajectory callback to the Tool seat', () => {
    const h = makeHarness({
      nodes: [toolResult(3, 'a')],
    })
    render(<h.ChatView {...h.props} />)
    expect(h.toolOwners[0]?.inspectCall).toBe(h.inspectCall)
  })

  it('shows assistant IconActions only on the last content message of each turn', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'),
        assistant(2, 'mid-turn text'),
        toolResult(3, 'a'),
        assistant(4, 'final answer'),
        user(5, 'next'),
        assistant(6, 'second turn', 2),
      ],
      turnEnds: new Map([[1, 4], [2, 6]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // One footer per closed turn plus one bubble per user message.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(4)
    expect(view.container.querySelectorAll('[data-turn-tail]')).toHaveLength(2)
  })

  it('withholds assistant IconActions while the turn is still running', () => {
    const h = makeHarness({
      running: true,
      runningCalls: [runningCall('a')],
      nodes: [
        user(1, 'first'),
        assistant(2, 'previous answer', 1),
        user(4, 'second'),
        assistant(5, 'mid-turn text', 2),
      ],
      // Boundary seqs follow the log: a turn/end is strictly after its own nodes.
      turnEnds: new Map([[1, 3]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // 2 user + the settled turn-1 tail, which keeps its seat while a later
    // turn runs; turn 2's narration stays chrome-free while its tool runs, so
    // the footer never appears and then moves.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(3)
    expect(view.getByText('mid-turn text')).toBeTruthy()
    // turn/end lands: the same node becomes the settled answer and takes the seat.
    act(() => { h.set({ running: false, runningCalls: [], turnEnds: new Map([[1, 3], [2, 6]]) }) })
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(4)
  })

  it('the actions-owning assistant footer shows the turn run time', () => {
    const h = makeHarness({
      nodes: [
        user(1, 'hi'), // time 1_000
        assistant(2, 'mid-turn text'),
        assistant(16, 'final answer'),
        toolResult(18, 'trailing'),
      ],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 20_000 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // The exact turn/end includes trailing tool activity after the final text.
    expect(view.getAllByText(/用时 19秒/)).toHaveLength(1)
  })

  it('the settled footer appends first-step ttft and turn decode throughput', () => {
    const first: AssistantMessageNode = {
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'mid' }],
      timing: { stepStartTime: 1_000, firstTokenTime: 2_200, completedTime: 5_200 },
      usage: { outputTokens: 40 },
    }
    const second: AssistantMessageNode = {
      kind: 'assistant', seq: 16, time: 16_000, turn: 1, step: 2, blocks: [{ kind: 'text', text: 'final' }],
      timing: { stepStartTime: 10_000, firstTokenTime: 10_200, completedTime: 12_200 },
      usage: { outputTokens: 60 },
    }
    const h = makeHarness({
      nodes: [user(1, 'hi'), first, second],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 20_000 }]]),
      turnEnds: new Map([[1, 20]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // First-step ttft (1.2s) plus 100 tokens over 5s of decode.
    expect(view.getAllByText(/用时 19秒/)).toHaveLength(1)
    expect(view.getAllByText(/首 token 1\.2秒/)).toHaveLength(1)
    expect(view.getAllByText(/20 tok\/s/)).toHaveLength(1)
  })

  it('withholds ttft and throughput while the turn is still running', () => {
    const settled: AssistantMessageNode = {
      kind: 'assistant', seq: 2, time: 2_000, turn: 1, step: 1, blocks: [{ kind: 'text', text: 'answer' }],
      timing: { stepStartTime: 1_000, firstTokenTime: 1_500, completedTime: 2_000 },
      usage: { outputTokens: 10 },
    }
    const h = makeHarness({
      nodes: [user(1, 'hi'), settled],
      turnTimings: new Map([[1, { startTime: 1_000 }]]),
      turnEnds: new Map(),
      running: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/首 token|tok\/s/)).toBeNull()
  })

  it('user and assistant message containers scope the hover-revealed time chrome', () => {
    const h = makeHarness({
      nodes: [user(1, 'hi'), assistant(2, 'answer')],
      turnTimings: new Map([[1, { startTime: 1_000, endTime: 2_000 }]]),
      turnEnds: new Map([[1, 2]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // The user row and the settled assistant's Turn Tail each own one clock scope.
    expect(view.container.querySelectorAll('[data-time-hover-root]')).toHaveLength(2)
  })

  it('the run-time label is withheld when the turn start is outside the window', () => {
    const h = makeHarness({
      nodes: [assistant(16, 'tail without trigger')],
      turnEnds: new Map([[1, 16]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/用时/)).toBeNull()
  })

  it('keeps final content actions when Tool and interrupted Think follow them', () => {
    const interruptedThink: AssistantMessageNode = {
      kind: 'assistant', seq: 4.1, time: 4_100, turn: 1, step: 2,
      blocks: [{ kind: 'reasoning', text: 'bad path' }], interrupted: true,
    }
    const h = makeHarness({
      nodes: [user(1, 'question'), assistant(2, 'answer'), toolResult(3, 'a'), interruptedThink],
      turnEnds: new Map([[1, 5]]),
    })
    const view = render(<h.ChatView {...h.props} />)
    // Both message rows keep copy; the Turn Tail adds none of its own here.
    expect(view.getAllByRole('button', { name: '复制' })).toHaveLength(2)
    expect(view.container.querySelectorAll('[data-turn-tail]')).toHaveLength(1)
  })

  it('renders assistant Markdown across history, streaming, final, and interrupted states while user text stays literal', () => {
    const markdown = '# Rendered\n\n- **one**\n- `two`'
    const h = makeHarness({ nodes: [user(1, markdown), assistant(2, markdown)] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelectorAll('h1')).toHaveLength(1)
    const literal = view.getByText((_content, element) => (
      element?.tagName === 'DIV' && element.childElementCount === 0 && element.textContent === markdown
    ))
    expect(literal.querySelector('h1')).toBeNull()

    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: markdown }] } })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"] h1')?.textContent).toBe('Rendered')

    act(() => {
      h.set({
        nodes: [user(1, markdown), assistant(2, markdown), assistant(3, markdown)],
        partial: null,
      })
    })
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
    expect(view.container.querySelector('[data-streaming="true"]')).toBeNull()

    act(() => {
      h.set({
        nodes: [
          user(1, markdown),
          assistant(2, markdown),
          { ...assistant(3, markdown), interrupted: true },
        ],
      })
    })
    expect(view.getByText('已停止')).toBeTruthy()
    expect(view.container.querySelectorAll('h1')).toHaveLength(2)
  })

  it('streaming partial frames update the tail without replacing a sibling Tool row', () => {
    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(2, 'old answer'), toolResult(3, 'a')],
    })
    const view = render(<h.ChatView {...h.props} />)
    const tool = view.getByTestId('tool-seat-a')
    const beforeHtml = tool.innerHTML
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'streaming…' }] } })
    })
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'streaming… more' }] } })
    })
    expect(view.getByText('streaming… more')).toBeTruthy()
    expect(view.getByTestId('tool-seat-a')).toBe(tool)
    expect(tool.innerHTML).toBe(beforeHtml)
  })

  it('streaming leaves neighbor tool rows and history items at zero re-renders', () => {
    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(2, 'old'), toolResult(3, 'a')],
    })
    // Count renderSlot invocations: the memo boundary holds when CallRow does
    // not re-render, so the row's renderSlot call count freezes during chunks.
    let rowRenders = 0
    h.props.renderSlot = ((key: string, owner: object) => {
      if (key !== 'conversation.chat.node'
        || (owner as RoutedChatNodeOwner).node.kind !== 'tool-call') return null
      rowRenders += 1
      return <div data-testid="counting-row" />
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('counting-row')).toBeTruthy()
    const afterMount = rowRenders
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'chunk1' }] } })
    })
    act(() => {
      h.set({ partial: { turn: 2, step: 1, blocks: [{ kind: 'text', text: 'chunk1 chunk2' }] } })
    })
    expect(rowRenders).toBe(afterMount)
  })

  it('updates the selected call id handed to the Tool seat', () => {
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    render(<h.ChatView {...h.props} />)
    expect(h.toolOwners.at(-1)?.selectedCallId).toBeUndefined()
    act(() => { h.setSelection({ turnSeq: 3, callId: 'a', toolName: 'bash' }) })
    expect(h.toolOwners.at(-1)?.selectedCallId).toBe('a')
  })

  it('hands running calls to a live Tool group', () => {
    const h = makeHarness({ runningCalls: [runningCall('r1')], running: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByTestId('tool-seat-r1')).toBeTruthy()
    expect(h.toolOwners[0]?.block).toMatchObject({ callId: 'r1', argsRaw: '{"command":"cmd-r1"}' })
    // This session row carries no preset: the generic verb, never empty.
    expect(statusVerb(view)).toBe(zh['status.working'])
  })

  it('keeps the Tool renderer mounted when a running call settles into log order', () => {
    const mounted = vi.fn()
    const unmounted = vi.fn()
    function StatefulToolNode({ node }: { readonly node: ChatNode<'tool-call'> }) {
      useEffect(() => {
        mounted()
        return () => { unmounted() }
      }, [])
      const root = node.data.root
      return (
        <div data-testid="stateful-tool" data-state={'kind' in root ? 'settled' : 'running'}>
          {root.callId}
        </div>
      )
    }

    const h = makeHarness({
      nodes: [user(1, 'q'), assistant(4, 'later')],
      runningCalls: [runningCall('r1')],
      running: true,
    })
    h.props.renderSlot = ((key: string, owner: object, opts?: { fallback?: React.ReactNode }) => {
      const routed = owner as RoutedChatNodeOwner
      return key === 'conversation.chat.node' && routed.node.kind === 'tool-call'
        ? <StatefulToolNode node={routed.node} />
        : opts?.fallback ?? null
    }) as ChatViewSlotProps['renderSlot']
    const view = render(<h.ChatView {...h.props} />)
    const tool = view.getByTestId('stateful-tool')
    const row = view.container.querySelector('[data-chat-flow-key="fixture:tool:r1"]')
    expect(tool.dataset.state).toBe('running')
    expect(mounted).toHaveBeenCalledTimes(1)

    act(() => {
      h.set({
        nodes: [user(1, 'q'), toolResult(3, 'r1'), assistant(4, 'later')],
        runningCalls: [],
        running: false,
      })
    })

    expect(view.getByTestId('stateful-tool')).toBe(tool)
    expect(view.container.querySelector('[data-chat-flow-key="fixture:tool:r1"]')).toBe(row)
    expect(tool.dataset.state).toBe('settled')
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(unmounted).not.toHaveBeenCalled()
  })

  it('the running clock uses turn/start, ignores steering, and stays out of the live region', () => {
    const startTime = Date.now() - 125_000
    const trigger: UserMessageNode = { ...user(1, 'go'), time: startTime + 1 }
    const h = makeHarness({
      nodes: [trigger], turnTimings: new Map([[1, { startTime }]]), running: true,
    })
    const view = render(<h.ChatView {...h.props} />)
    // Freshly mounted (as after a reload) yet already past the 15s gate.
    const status = view.getByRole('status')
    expect(statusVerb(view)).toBe(zh['status.working'])
    expect(status.textContent).toMatch(/^正在工作\.\.\.2分0\d秒$/)
    expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull()
    act(() => {
      h.set({ queue: [{
        id: 'steering-occurrence' as never,
        messageId: 'steering-message' as never,
        placement: 'steering',
        content: [{ type: 'text', text: 'also' }],
        preview: 'also',
        text: 'also',
      }] })
    })
    expect(statusVerb(view)).toBe(zh['status.working'])
    expect(status.textContent).toMatch(/^正在工作\.\.\.2分0\d秒$/)
  })

  // The verb Owen asked for, per agent preset, in English product copy.
  const TURN_VERBS: ReadonlyArray<readonly [string | undefined, string]> = [
    ['delta', 'Working...'],
    ['darwin', 'Working...'],
    ['diana', 'Chatting...'],
    ['dexter', 'Thinking...'],
    // A preset this deployment composes but the map does not know.
    ['household-guest', 'Working...'],
    // A session row that carries no preset at all.
    [undefined, 'Working...'],
  ]
  for (const [preset, verb] of TURN_VERBS) {
    it(`the running-turn status says ${verb} for preset ${preset ?? '(none)'}`, () => {
      const h = makeHarness({ nodes: [user(1, 'q')], running: true })
      h.props.useSessions = sessionsWith(preset)
      h.props.t = makeTranslate(en, commonZh)
      const view = render(<h.ChatView {...h.props} />)
      const status = view.getByRole('status')
      expect(statusVerb(view)).toBe(verb)
      // The live-region contract and the clock's 15s gate are untouched.
      expect(status.getAttribute('aria-live')).toBe('polite')
      expect(status.querySelector('[aria-hidden="true"]')).toBeNull()
    })
  }

  it('hands each ordered root call to the keyed business-node slot', () => {
    const block = toolResult(3, 'a')
    const h = makeHarness({ nodes: [block] })
    const calls: { key: string; owner: object; entryKey?: string }[] = []
    h.props.renderSlot = ((key: string, owner: object, opts?: { entryKey?: string; fallback?: React.ReactNode }) => {
      calls.push({ key, owner, ...(opts?.entryKey !== undefined ? { entryKey: opts.entryKey } : {}) })
      return opts?.fallback ?? null
    })
    render(<h.ChatView {...h.props} />)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({
      key: 'conversation.chat.node',
      owner: { node: { kind: 'tool-call' }, selectedCallId: undefined },
      entryKey: 'tool-call',
    })
    const owner = calls[0]?.owner as RoutedChatNodeOwner
    expect((owner.node.data as { readonly root: ToolCallBlock }).root).toBe(block)
    expect(owner.openFile).not.toBe(h.openFile)
    owner.openFile('src/a.ts')
    expect(h.openFile).toHaveBeenCalledWith('src/a.ts')
    expect(owner.inspectCall).toBe(h.inspectCall)
  })

  it('shows a Host open refusal with the reason and retries the same path', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('xdg-open is not available'))
      .mockResolvedValueOnce(undefined)
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('src/a.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' })).toBeTruthy()
    })
    expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('xdg-open is not available')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull()
    })
    expect(openFile).toHaveBeenCalledTimes(2)
    expect(openFile).toHaveBeenNthCalledWith(1, 'src/a.ts')
    expect(openFile).toHaveBeenNthCalledWith(2, 'src/a.ts')
  })

  it('keeps a non-Error Host refusal visible and dismisses it on cancel', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce('permission denied')
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('notes.md') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('permission denied')
    })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(openFile).toHaveBeenCalledTimes(1)
  })

  it('substitutes the unknown-open copy when the Host refusal has no text', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error(''))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('empty.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('无法打开此文件')
    })
  })

  it('names a workspace-folder Host refusal as a folder', async () => {
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error(''))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('.') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件夹' }).textContent).toContain('无法打开此文件夹')
    })
  })

  it('ignores a Host refusal that settles after the dialog is dismissed', async () => {
    let rejectRetry!: (error: unknown) => void
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first refusal'))
      .mockImplementationOnce(() => new Promise<void>((_resolve, reject) => {
        rejectRetry = reject
      }))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('src/a.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('first refusal')
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await act(async () => { rejectRetry(new Error('late refusal')) })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('ignores a Host open that succeeds after the dialog is dismissed', async () => {
    let resolveRetry!: () => void
    const openFile = vi.fn<(path: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('first refusal'))
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveRetry = () => { resolve() }
      }))
    const h = makeHarness({ nodes: [toolResult(3, 'a')] })
    h.props.openFile = openFile
    render(<h.ChatView {...h.props} />)
    await act(async () => { h.toolOwners[0]!.openFile('src/a.ts') })
    await waitFor(() => {
      expect(screen.getByRole('dialog', { name: '无法打开文件' }).textContent).toContain('first refusal')
    })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '重试' })) })
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await act(async () => { resolveRetry() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('a trailing user node force-scrolls a reader who had scrolled away', () => {
    const h = makeHarness({ nodes: [user(5, 'later'), assistant(6, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 400, writable: true })
    readerScroll(scroller, 80)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1600, writable: true })
    // A new trailing user bubble (own words) force-scrolls to the bottom.
    act(() => { h.set({ nodes: [user(5, 'later'), assistant(6, 'a'), user(9, 'mine')] }) })
    expect(scroller.scrollTop).toBe(1600)
  })

  it('scrolling away disables follow and shows the back-to-bottom button; clicking returns', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    readerScroll(scroller, 100) // far from bottom
    const backButton = view.getByLabelText('回到底部')
    expect(backButton).toBeTruthy()
    // Streaming growth must NOT drag a scrolled-away reader down.
    act(() => { h.set({ partial: { turn: 1, step: 1, blocks: [{ kind: 'text', text: 'grow' }] } }) })
    expect(scroller.scrollTop).toBe(100)
    fireEvent.click(backButton)
    expect(scroller.scrollTop).toBe(1000)
    // At the bottom again: follow re-arms and the button unmounts.
    expect(view.queryByLabelText('回到底部')).toBeNull()
  })

  it('keeps following when a stream-finalization shrink clamp delivers its scroll', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    const metrics = installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)

    // Stream finalization shrinks the column: the browser clamps the pinned
    // position onto the new floor and delivers a scroll event. The clamp
    // lands exactly on the ledger's floor min, so it is not reader input.
    metrics.setLayout(800, 700)
    fireEvent.scroll(scroller)
    expect(scroller.scrollTop).toBe(500)
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(h.chatScroll.read()).toBeNull()

    metrics.setHeight(1_200)
    act(() => { h.set({ running: true }) })
    expect(scroller.scrollTop).toBe(900)
  })

  it('uses the last delivered top when compositor scrolling precedes scroll delivery', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    installScrollMetrics(scroller, 1_000, 300)
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)

    // Chromium advances compositor geometry before delivering the event:
    // attribution must compare against the observed-top ledger, never a
    // baseline sampled from already-moved raw geometry.
    scroller.scrollTop = 500
    fireEvent.scroll(scroller)
    expect(view.getByLabelText('回到底部')).toBeTruthy()
  })

  it('one ResizeObserver owns pinned dynamic-height follow and ignores growth while away', () => {
    let notify: (() => void) | undefined
    const observe = vi.fn()
    class ResizeObserverStub {
      constructor(callback: ResizeObserverCallback) {
        notify = () => { callback([], this as unknown as ResizeObserver) }
      }

      observe = observe
      disconnect = vi.fn()
    }
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    scroller.scrollTop = 700
    fireEvent.scroll(scroller)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_200, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(1_200)
    readerScroll(scroller, 200)
    Object.defineProperty(scroller, 'scrollHeight', { value: 1_400, writable: true })
    act(() => { notify?.() })
    expect(scroller.scrollTop).toBe(200)
    expect(observe).toHaveBeenCalledTimes(1)
  })

  it('entering the at-bottom threshold does not snap the remaining scroll distance', () => {
    const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
    const view = render(<h.ChatView {...h.props} />)
    const scroller = view.container.querySelector('[class*="scroll"]') as HTMLDivElement
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000, writable: true })
    Object.defineProperty(scroller, 'clientHeight', { value: 300, writable: true })
    // Inside FOLLOW_THRESHOLD (24) but not flush with the floor — the chrome
    // re-render from setAtBottom must not force scrollTop to scrollHeight.
    readerScroll(scroller, 690) // distance-to-bottom = 10
    expect(view.queryByLabelText('回到底部')).toBeNull()
    expect(scroller.scrollTop).toBe(690)
  })

  it('under data-conversation-scroll, bottom-follow targets the host scrollport', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // Open jump uses the host, not the local .scroll node.
      expect(host.scrollTop).toBe(2000)
      readerScroll(host, 100)
      expect(view.getByLabelText('回到底部')).toBeTruthy()
      fireEvent.click(view.getByLabelText('回到底部'))
      expect(host.scrollTop).toBe(2000)
    } finally {
      host.remove()
    }
  })

  it('a remount restores the saved semantic row after width reflow', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    let anchorTop = 80
    vi.spyOn(host, 'getBoundingClientRect').mockImplementation(
      () => ({ top: 0, bottom: 500 } as DOMRect),
    )
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:1') {
        return { top: anchorTop, bottom: anchorTop + 40 } as DOMRect
      }
      return { top: 0, bottom: 40 } as DOMRect
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      // Fresh open (nothing saved): the bottom jump stands.
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(2000)
      // Reader scrolls up; the position is recorded continuously.
      readerScroll(host, 100)
      // View-tab switch away and back: the view unmounts, then remounts.
      view.rerender(<div />)
      anchorTop = 560
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(580) // approximate 100 + the row's 480px reflow shift
      // The restored position is above the floor: follow stays disarmed.
      expect(view.getByLabelText('回到底部')).toBeTruthy()
    } finally {
      rect.mockRestore()
      host.remove()
    }
  })

  it('normalizes a semantic restore clamped to the bottom before an immediate remount', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2_000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    let scrollTop = 0
    Object.defineProperty(host, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = Math.min(value, 1_500) },
    })
    document.body.appendChild(host)
    const rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.dataset.chatAnchorKey === 'fixture:user:1') return { top: 300, bottom: 340 } as DOMRect
      return { top: 0, bottom: 500 } as DOMRect
    })
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      h.chatScroll.save({ anchorKey: 'fixture:user:1', anchorTop: 80, scrollTop: 1_400 })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      expect(host.scrollTop).toBe(1_500)
      expect(h.chatScroll.read()).toBeNull()
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(1_500)
    } finally {
      rect.mockRestore()
      host.remove()
    }
  })

  it('a remount while pinned to the bottom keeps the bottom jump', () => {
    const host = document.createElement('div')
    host.setAttribute('data-conversation-scroll', '')
    Object.defineProperty(host, 'scrollHeight', { value: 2000, writable: true, configurable: true })
    Object.defineProperty(host, 'clientHeight', { value: 500, writable: true, configurable: true })
    Object.defineProperty(host, 'scrollTop', { value: 0, writable: true, configurable: true })
    document.body.appendChild(host)
    try {
      const h = makeHarness({ nodes: [user(1, 'q'), assistant(2, 'a')] })
      const view = render(<h.ChatView {...h.props} />, { container: host })
      // At the bottom: the scroll event records the pinned state (null).
      fireEvent.scroll(host)
      expect(h.chatScroll.read()).toBeNull()
      view.rerender(<div />)
      host.scrollTop = 0
      view.rerender(<h.ChatView {...h.props} />)
      expect(host.scrollTop).toBe(2000)
    } finally {
      host.remove()
    }
  })

  it('never grows the window when the session reports older history outside it', () => {
    // `hasMore` survives on the snapshot as a runtime fact (the trajectory
    // view reads it); the chat transcript must not act on it.
    const h = makeHarness({ nodes: [user(5, 'later')], hasMore: true })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.container.querySelectorAll('[data-chat-flow-key]')).toHaveLength(1)
    act(() => { h.set({ loadingOlder: true }) })
    // A busy flag from any other surface still renders no chat affordance.
    expect(view.container.querySelectorAll('[data-chat-flow-key]')).toHaveLength(1)
    expect(view.queryByText('加载中…')).toBeNull()
  })

  it('shows open error and loading states', () => {
    const h = makeHarness({
      openState: 'error',
      openError: { code: 'internal', message: 'boom' } as never,
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText(/历史加载失败：boom/)).toBeTruthy()
    const loading = makeHarness({ openState: 'loading' })
    const lv = render(<loading.ChatView {...loading.props} />)
    expect(lv.getByText('载入历史…')).toBeTruthy()
  })

  it('pending waits leave the flow entirely — questions and approvals both take over the composer', () => {
    const h = makeHarness({
      pending: [
        new PendingWait('approval', RpcId('r1'), SID,
          { approvalId: 'ap1', toolName: 'bash' } as PendingWait<'approval'>['payload'], vi.fn()),
        new PendingWait('question', RpcId('r2'), SID,
          { questions: [{ id: 'q1', question: '选择' }] }, vi.fn()),
      ],
    })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.queryByText(/等待回答/)).toBeNull()
    expect(view.queryByText(/等待审批/)).toBeNull()
  })

  it('renders command nodes as durable rows: settled text, error state, executing spinner, run-less soft-fall', () => {
    // Settled success: the bare command name is the title, the outcome text
    // the summary — neither the dispatched `/` nor its arguments reach the row
    // (the settlement text already says what the command did).
    const settled = makeHarness({ nodes: [user(1, 'hi'), command({ args: ' now' })] })
    const view = render(<settled.ChatView {...settled.props} />)
    expect(view.getByText('plan')).toBeTruthy()
    expect(view.queryByText('/plan')).toBeNull()
    expect(view.queryByText('/plan now')).toBeNull()
    expect(view.getByText('已进入 plan mode')).toBeTruthy()

    // Error outcome flips the row state; a text-less error gets the default copy.
    const failed = makeHarness({
      nodes: [command({ seq: 6, commandId: 'cmd-2' as CommandNode['commandId'], outcome: { kind: 'error' } })],
    })
    const fv = render(<failed.ChatView {...failed.props} />)
    expect(fv.container.querySelector('[data-state="error"]')).not.toBeNull()
    expect(fv.getByText('命令失败')).toBeTruthy()
    expect(fv.getByText('失败')).toBeTruthy()

    // Still executing: running state with the executing copy.
    const executing = makeHarness({
      nodes: [command({ seq: 7, commandId: 'cmd-3' as CommandNode['commandId'], outcome: null })],
    })
    const xv = render(<executing.ChatView {...executing.props} />)
    expect(xv.container.querySelector('[data-state="running"]')).not.toBeNull()
    expect(xv.getByText('执行中…')).toBeTruthy()
    expect(xv.getByText('运行中')).toBeTruthy()

    // Cross-window soft-fall (run page truncated): generic title, outcome preserved.
    const orphan = makeHarness({
      nodes: [command({ seq: 8, commandId: 'cmd-4' as CommandNode['commandId'], name: null, args: null, outcome: { kind: 'success' } })],
    })
    const ov = render(<orphan.ChatView {...orphan.props} />)
    expect(ov.getByText('命令')).toBeTruthy()
    expect(ov.getByText('已完成')).toBeTruthy()
  })

  it('renders /compact as one stateful disclosure from running through completion', () => {
    const running = command({
      commandId: 'cmd-compact' as CommandNode['commandId'],
      name: 'compact',
      outcome: null,
    })
    const h = makeHarness({ nodes: [running] })
    const view = render(<h.ChatView {...h.props} />)
    expect(view.getByText('正在压缩…')).toBeTruthy()
    expect(view.container.querySelector('[data-state="running"]')).not.toBeNull()

    act(() => {
      h.set({
        nodes: [{
          ...running,
          outcome: {
            kind: 'success',
            text: 'Compacted 16 history items (~11309 tokens).',
            sourceEventSeq: 7,
          },
        }, compaction()],
      })
    })

    expect(view.queryByText('正在压缩…')).toBeNull()
    expect(view.queryByText('上下文已压缩')).toBeNull()
    expect(view.getByText('已压缩 16 条历史记录（约 11309 tokens）')).toBeTruthy()
    const row = view.getByRole('button', { name: /compact/ })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(row.querySelector('[data-compaction-icon="context"]')).not.toBeNull()
    expect(row.querySelector('[data-compaction-disclosure="collapsed"]')).not.toBeNull()
    expect(view.queryByText('保留的事实。')).toBeNull()
    fireEvent.click(row)
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(row.querySelector('[data-compaction-disclosure="expanded"]')).not.toBeNull()
    expect(view.getByRole('heading', { name: '压缩摘要' })).toBeTruthy()
  })

  it('keeps /compact no-history and error settlements on the generic command row', () => {
    const noHistory = makeHarness({
      nodes: [command({
        name: 'compact',
        outcome: { kind: 'success', text: 'No compactable history yet.' },
      })],
    })
    const noHistoryView = render(<noHistory.ChatView {...noHistory.props} />)
    expect(noHistoryView.getByText('No compactable history yet.')).toBeTruthy()
    expect(noHistoryView.queryByRole('button')).toBeNull()

    const failed = makeHarness({
      nodes: [command({
        commandId: 'cmd-compact-failed' as CommandNode['commandId'],
        name: 'compact',
        outcome: { kind: 'error', text: 'Compaction cancelled.' },
      })],
    })
    const failedView = render(<failed.ChatView {...failed.props} />)
    expect(failedView.getByText('Compaction cancelled.')).toBeTruthy()
    expect(failedView.container.querySelector('[data-state="error"]')).not.toBeNull()
  })
})
