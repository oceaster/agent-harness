/** Per-person channel history, owned outside React and refreshed while open. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One channel the authenticated API allows this person to see. */
export interface AgentChannel { id: string; name: string; agents: string[] }
/** Durable peer-agent message, including its delivery outcome. */
export interface ChannelMessage {
  id: string
  sender: string
  recipient: string
  content: string
  priority: string
  created: number
  status: string
}
/** The channel browser's current snapshot. */
export interface ChannelState {
  rows: AgentChannel[]
  selected: AgentChannel | null
  messages: ChannelMessage[]
  error: string | null
  loading: boolean
}

/** Owns network reads and channel selection; the view only renders its snapshot. */
export class ChannelController {
  /** Shared channel selection and transcript rendered by the sidebar and chat tile. */
  readonly store = createSnapshotStore<ChannelState>({ rows: [], selected: null, messages: [], error: null, loading: false })
  private reading = false
  private revision = 0
  /** Refresh permitted channel rows from the caller's own cookie-authenticated API. */
  async load(): Promise<void> {
    try {
      const response = await fetch('/v1/browser/inbox/channels', { credentials: 'same-origin', signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error('Agent channels could not load. Try Refresh.')
      const body = await response.json() as { channels?: AgentChannel[] }
      if (!Array.isArray(body.channels)) throw new Error('Agent channels could not load. Try Refresh.')
      this.store.set({ ...this.store.getSnapshot(), rows: body.channels, error: null })
    } catch (error) { this.store.set({ ...this.store.getSnapshot(), error: String(error instanceof Error ? error.message : error) }) }
  }
  /** Open one server-provided channel without choosing or creating an agent conversation.
   * @param id - channel id returned by the authenticated list.
   */
  async open(id: string): Promise<void> {
    const state = this.store.getSnapshot(), selected = state.rows.find(row => row.id === id)
    if (selected === undefined) return
    this.store.set({ ...state, selected, messages: [], error: null, loading: true })
    await this.refresh()
  }
  /** Clear only the person's selected channel history after confirmation in the view.
   * @param id - channel to clear; omitted uses the current selection.
   */
  async clear(id?: string): Promise<void> {
    const state = this.store.getSnapshot()
    const channel = id === undefined ? state.selected : state.rows.find(row => row.id === id) ?? null
    if (channel === null) return
    try {
      const response = await fetch('/v1/browser/inbox/channels/' + encodeURIComponent(channel.id) + '/clear', {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(8000),
      })
      if (!response.ok || (await response.json() as { cleared?: boolean }).cleared !== true) {
        throw new Error('The channel could not be cleared. Try again.')
      }
      this.revision++
      const current = this.store.getSnapshot()
      this.store.set({ ...current, error: null,
        ...(current.selected?.id === channel.id ? { messages: [], loading: false } : {}),
      })
    } catch (error) {
      const current = this.store.getSnapshot()
      this.store.set({ ...current, error: error instanceof Error ? error.message : String(error) })
    }
  }
  /** Return to the agent conversation while preserving channel history on the server. */
  close(): void { this.store.set({ ...this.store.getSnapshot(), selected: null, loading: false }) }
  /** Poll only the open channel; a selection change cannot display another channel's response. */
  async refresh(): Promise<void> {
    const channel = this.store.getSnapshot().selected
    if (channel === null || this.reading) return
    this.reading = true
    const revision = this.revision
    try {
      const response = await fetch('/v1/browser/inbox/channels/' + encodeURIComponent(channel.id), { credentials: 'same-origin', signal: AbortSignal.timeout(8000) })
      if (!response.ok) throw new Error('Channel history could not load. Try Refresh.')
      const body = await response.json() as { messages?: ChannelMessage[] }
      if (!Array.isArray(body.messages)) throw new Error('Channel history could not load. Try Refresh.')
      const current = this.store.getSnapshot()
      if (this.revision === revision && current.selected?.id === channel.id) {
        this.store.set({ ...current, messages: body.messages, loading: false, error: null })
      }
    } catch (error) {
      const current = this.store.getSnapshot()
      if (current.selected?.id === channel.id) {
        this.store.set({ ...current, loading: false, error: error instanceof Error ? error.message : String(error) })
      }
    } finally { this.reading = false }
  }
}
