// @vitest-environment jsdom
/**
 * ChannelPage: what the read-only agent channel shows in each read phase.
 *
 * The suite drives the channel snapshot directly and asserts user-visible
 * behavior: a loaded, error-free, message-less channel renders the household
 * mark (and no copy sentence), while a loading read, a failed read and a
 * transcript with messages render neither. The failed read keeps its
 * role="alert" row — a channel that could not be read must never be dressed up
 * as an empty one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import { ChannelPage } from '../src/client/ChannelPage.tsx'
import type { ChannelPageProps } from '../src/client/ChannelPage.tsx'
import type { AgentChannel, ChannelMessage, ChannelState } from '../src/client/channel-controller.ts'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t: ChannelPageProps['t'] = makeTranslate(en, commonZh)

const CHANNEL: AgentChannel = { id: 'delta-darwin', name: 'Delta-Darwin', agents: ['delta', 'darwin'] }

const MESSAGE: ChannelMessage = {
  id: 'm-1',
  sender: 'delta',
  recipient: 'darwin',
  content: 'Deploy window at noon.',
  priority: 'normal',
  created: new Date('2026-06-01T12:00:00Z').getTime() / 1000,
  status: 'accepted',
}

/** Mount the channel page over a driven snapshot. */
function mount(state: Partial<ChannelState> = {}) {
  const channels = createSnapshotStore<ChannelState>({
    rows: [CHANNEL],
    selected: CHANNEL,
    messages: [],
    error: null,
    loading: false,
    ...state,
  })
  const refreshChannel = vi.fn()
  // The runtime share also carries the global session/workspace hooks; a
  // channel page never reads them, so they are never-called stubs.
  const neverHook = (() => { throw new Error('the channel page must not read global hooks') }) as never
  const view = render(<ChannelPage
    useChannels={bindSnapshotSelector(channels)}
    refreshChannel={refreshChannel}
    useSessions={neverHook}
    useWorkspaces={neverHook}
    t={t}
  />)
  return { ...view, channels, refreshChannel }
}

describe('channel page: empty channel', () => {
  it('renders the household mark instead of the removed copy sentence', () => {
    mount()
    const placeholder = screen.getByTestId('agent-channel-empty')
    // The art: the masked household mark (e-server serves the asset at
    // /v1/browser/inbox/brand.svg) plus the soft glow ellipse behind it.
    expect(placeholder.querySelector('svg ellipse')).not.toBeNull()
    expect(placeholder.querySelector('div[class*="channelEmptyMark"]')).not.toBeNull()
    // Decoration only: the page keeps its own accessible name.
    expect(placeholder.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('agent-channel-page').getAttribute('aria-label')).toBe('Delta-Darwin')
    // The sentence the mark replaced is gone, copy and all.
    expect(screen.queryByText(/No messages yet\. Your agents can use this channel to coordinate\./)).toBeNull()
    expect('channel.empty' in en).toBe(false)
  })

  it('shows no loading line and no alert once the read landed', () => {
    mount()
    expect(screen.queryByText(en['channel.loading'])).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('channel page: reads that are not empty', () => {
  it('shows no mark while the history read is in flight', () => {
    mount({ loading: true })
    expect(screen.queryByTestId('agent-channel-empty')).toBeNull()
    expect(screen.getByText(en['channel.loading'])).toBeTruthy()
  })

  it('shows no mark for a failed read and keeps the alert row', () => {
    // The wire copy the controller stores on a refused history read.
    mount({ error: 'Channel history could not load. Try Refresh.' })
    expect(screen.queryByTestId('agent-channel-empty')).toBeNull()
    expect(screen.getByRole('alert').textContent).toBe('Channel history could not load. Try Refresh.')
  })

  it('shows no mark when the channel has messages', () => {
    mount({ messages: [MESSAGE] })
    expect(screen.queryByTestId('agent-channel-empty')).toBeNull()
    expect(screen.getAllByTestId('agent-channel-message')).toHaveLength(1)
  })
})
