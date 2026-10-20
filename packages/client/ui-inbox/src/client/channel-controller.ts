/** Per-person channel history, owned outside React and refreshed while open. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** One channel the authenticated API allows this person to see. */
export interface AgentChannel { id: string; name: string; agents: string[]; online?: boolean }
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
  /**
   * The durable half of the selection, and only the id: the row itself is
   * server data (its name, agents, presence) and is re-read from the list on
   * every boot, so restoring a stored row object would resurrect a stale
   * channel.
   */
  private readonly selection = createSnapshotStore<{ channelId: string | null }>(
    { channelId: null }, { persist: { name: 'dsh.inbox.channel' } })
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
    const selected = this.store.getSnapshot().rows.find(row => row.id === id)
    if (selected === undefined) return
    this.selection.set({ channelId: id })
    this.select(selected)
    await this.refresh()
  }
  /**
   * Reopen the channel this person was reading when the page last unloaded.
   * Called by the plugin once the server's rows are known, so the restore is
   * ONE step: the channel becomes the selection and the caller switches the
   * main view in the same write (ui-inbox is the single writer of the channel
   * page — see index.ts), which is what keeps the painted surface and the
   * sidebar's current row from ever disagreeing.
   *
   * A stored id that no longer resolves (the channel was cleared, removed, or
   * belongs to a different person's list) is dropped and the ordinary
   * conversation default stands: nothing failed, so nothing is reported.
   * @param openPage - selects the channel page; called only when the id resolves.
   * @returns the reopened channel id, or null when nothing was restored.
   */
  async restorePersisted(openPage: () => void): Promise<string | null> {
    const channelId = this.selection.getSnapshot().channelId
    if (channelId === null) return null
    const state = this.store.getSnapshot()
    // Rows are unknown yet (the read is in flight or failed): keep the id and
    // let the next read try. Only a rows set the server actually answered can
    // retire the selection.
    if (state.rows.length === 0) return null
    const channel = state.rows.find(row => row.id === channelId)
    if (channel === undefined) {
      this.selection.set({ channelId: null })
      return null
    }
    this.select(channel)
    openPage()
    await this.refresh()
    return channelId
  }
  /** Make one channel the selection and mark its transcript as loading. */
  private select(channel: AgentChannel): void {
    this.store.set({ ...this.store.getSnapshot(), selected: channel, messages: [], error: null, loading: true })
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
  close(): void {
    this.selection.set({ channelId: null })
    this.store.set({ ...this.store.getSnapshot(), selected: null, loading: false })
  }
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
