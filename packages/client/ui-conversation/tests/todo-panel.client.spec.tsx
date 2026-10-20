// @vitest-environment jsdom
/**
 * Todo display acceptance: the TodoPanel plan strip (empty-hidden, status rows
 * including several `in_progress` at once, collapse) and its TodoDock adapter
 * (selects the plan off the session snapshot, follows changes, and owns the
 * collapsed flag in the per-conversation disclosure store).
 */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { createConversationDisclosureStore } from '../src/client/disclosure-store.ts'
import type { TodoItem } from '@deepseek-ai/dsh-client-runtime/client'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { TodoDockProps } from '../src/client/skeleton/TodoPanel.tsx'
import { TodoDock, TodoPanel, todoDockEntry } from '../src/client/skeleton/TodoPanel.tsx'
import { NS, zh } from '../src/client/locales.ts'

// Mirrors the real lookup chain (conversation namespace, then common).
const t: TodoDockProps['t'] = makeTranslate(zh, commonZh)

afterEach(cleanup)

/** One conversation id: the session-scope key the disclosure store is created under. */
const SESSION = 'session-scope-todo-dock'

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

/** A parallel plan: three tasks running at once (concurrent subagents). */
const PARALLEL: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '跑后台构建', status: 'in_progress' },
  { content: '读源码', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

/**
 * Controlled harness: TodoPanel is presentational, so the collapsed flag is a
 * prop. This wrapper stands in for the dock adapter (which feeds it from the
 * disclosure store), keeping the panel's own rendering assertions unchanged.
 */
function CollapsiblePanel({ todos }: { todos: readonly TodoItem[] }) {
  const [collapsed, setCollapsed] = useState(true)
  return <TodoPanel todos={todos} collapsed={collapsed} onToggle={() => { setCollapsed(value => !value) }} t={t} />
}

describe('TodoPanel', () => {
  it('renders nothing while the list is empty', () => {
    const { container } = render(<TodoPanel todos={[]} collapsed onToggle={() => undefined} t={t} />)
    expect(container.innerHTML).toBe('')
  })

  it('starts collapsed with the per-status count summary visible', () => {
    render(<CollapsiblePanel todos={LIST} />)
    expect(screen.getByTestId('todo-panel')).toBeTruthy()
    expect(screen.getByText('任务')).toBeTruthy()
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
  })

  it('omits the completed segment while nothing is done yet', () => {
    render(<CollapsiblePanel todos={[
      { content: '写组件', status: 'in_progress' },
      { content: '补测试', status: 'pending' },
    ]} />)
    expect(screen.getByText('1 进行中 · 1 待处理')).toBeTruthy()
    expect(screen.queryByText(/已完成/)).toBeNull()
  })

  it('expands to show one row per item with its status glyph', () => {
    render(<CollapsiblePanel todos={LIST} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const items = screen.getAllByRole('listitem')
    expect(items.map(li => li.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(screen.getByText('搭骨架')).toBeTruthy()
    expect(screen.getByText('写组件')).toBeTruthy()
    // Each status row carries an SVG glyph (not a text bullet).
    expect(items.every(li => li.querySelector('svg') !== null)).toBe(true)
  })

  it('collapse hides an expanded list; expand restores; header keeps the count summary', () => {
    render(<CollapsiblePanel todos={LIST} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    const header = screen.getByRole('button', { expanded: true })
    fireEvent.click(header)
    expect(screen.queryByRole('list')).toBeNull()
    // Collapsed header is title + progress only (no in-progress content hint).
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    expect(screen.queryByText('写组件')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('marks every parallel active item, and counts them all in the header', () => {
    render(<CollapsiblePanel todos={PARALLEL} />)
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    // An unconditional in-progress cap would make this list unreachable: three
    // items carry the in-progress glyph at once, and the header counts all three.
    const statuses = screen.getAllByRole('listitem').map(li => li.getAttribute('data-status'))
    expect(statuses.filter(s => s === 'in_progress')).toHaveLength(3)
    expect(screen.getByText('跑后台构建')).toBeTruthy()
    expect(screen.getByText('读源码')).toBeTruthy()
    expect(screen.getByText('1 已完成 · 3 进行中 · 1 待处理')).toBeTruthy()
  })

  it('an all-completed list collapses the summary to the done count alone', () => {
    render(<CollapsiblePanel todos={[{ content: '都完了', status: 'completed' }]} />)
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(screen.queryByText('都完了')).toBeNull()
    expect(screen.getByText('1 已完成')).toBeTruthy()
    expect(screen.queryByText(/进行中|待处理/)).toBeNull()
  })
})

/**
 * Dock props stub: the 'todos' projection source plus a real disclosure-store
 * instance (the same one the registration creates per session scope), so the
 * adapter's reads and writes go through the shipped store, not a stand-in.
 */
function dockProps(
  projection: ReturnType<typeof createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>>,
  disclosure = createConversationDisclosureStore().create(SESSION),
): TodoDockProps {
  const useProjection = (_key: string, selector?: (v: unknown) => unknown) =>
    bindSnapshotSelector(projection)(s => (selector ?? (v => v))(s.value))
  return {
    useProjection,
    useStore: bindSnapshotSelector(disclosure),
    actions: disclosure.actions,
    t,
  } as unknown as TodoDockProps
}

describe('TodoDock', () => {
  it('reads the host-computed todos projection and follows pushed updates', () => {
    const store = createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>({ value: undefined })
    render(<TodoDock {...dockProps(store)} />)
    // Capability absent (no baseline/frame yet) renders nothing.
    expect(screen.queryByTestId('todo-panel')).toBeNull()
    act(() => { store.set({ value: LIST }) })
    expect(screen.getByText('1 已完成 · 1 进行中 · 1 待处理')).toBeTruthy()
    // The pre-first-write whole value (null) retires the strip (the panel owns no data).
    act(() => { store.set({ value: null }) })
    expect(screen.queryByTestId('todo-panel')).toBeNull()
  })

  it('starts collapsed, then writes the expansion into the disclosure store', () => {
    const projection = createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>({ value: LIST })
    const disclosure = createConversationDisclosureStore().create(SESSION)
    render(<TodoDock {...dockProps(projection, disclosure)} />)
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    expect(screen.queryByRole('list')).toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    // The adapter does not keep a private copy: the store is the only owner.
    expect(disclosure.getSnapshot().planCollapsed).toBe(false)
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('renders expanded when the conversation scope already holds an expansion', () => {
    // A restored conversation: the store rehydrates planCollapsed=false, and the
    // strip comes back open without the reader touching it again.
    const projection = createSnapshotStore<{ value: readonly TodoItem[] | null | undefined }>({ value: LIST })
    const disclosure = createConversationDisclosureStore().create(SESSION)
    act(() => { disclosure.actions.setPlanCollapsed(false) })
    render(<TodoDock {...dockProps(projection, disclosure)} />)
    expect(screen.getByRole('button', { expanded: true })).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(3)
  })

  it('registers before the goal and queue entries', () => {
    expect(todoDockEntry.name).toBe('conversation-todo-dock')
    expect(todoDockEntry.inject).toEqual(['slots'])
    const register = vi.fn(() => () => undefined)
    const inject = vi.fn((_name: string, callback: () => () => void) => callback())
    todoDockEntry.apply({ slots: { inject, register } } as never)
    expect(inject).toHaveBeenCalledWith('conversation.input.dock', expect.any(Function))
    // The registration carries the disclosure store, and it is the exclusive
    // factory form so the framework instantiates one per session scope.
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'conversation.input.dock',
      id: 'todo',
      order: 0,
      locale: NS,
      store: createConversationDisclosureStore,
    }), TodoDock)
  })
})
