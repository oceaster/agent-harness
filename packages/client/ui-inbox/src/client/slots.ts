/**
 * Inbox slot contract: the injected business face the panel renders and the
 * composed props alias. The `sidebar.workspaces` entry itself is declared by
 * ui-sidebar (imported type-only for its SlotMap merge).
 *
 * The inject face carries only plain data and callbacks: the snapshot source
 * rides the reserved `hooks` compartment (the renderer binds it to `useInbox`),
 * and the verbs are closures over the apply-scope controller.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.workspaces' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InboxState } from './inbox-controller.ts'
import type { ChannelState } from './channel-controller.ts'

/** Registrant-private injected share (arrives via the register inject factory). */
export interface InboxInjected {
  hooks: {
    /** The controller's whole snapshot: rows, phases, per-row busy and notices. */
    inbox: SnapshotStore<InboxState>
    /** Permitted channels and the selected channel history. */
    channels: SnapshotStore<ChannelState>
  }
  /** Read (or re-read) the caller's inbox. */
  load: () => void
  /** Open one row's conversation through the inbox API. */
  open: (agent: string) => void
  /**
   * Open one sub-agent of the conversation the pane has open, through the
   * catalog-derived address its row carries. Makes no request of its own: the
   * runtime's `openSubagent` moves the selection, and the conversation it then
   * paints is the harness's own read-only one.
   */
  openWorker: (id: string) => void
  /** Destroy one row's conversation through the inbox API. */
  clear: (agent: string) => void
  /** Open the channel selected from the server's list. */
  openChannel: (channel: string) => void
  /** Clear the selected channel after an explicit confirmation. */
  clearChannel: (id: string) => void
}

/** Full component props: the slot's runtime share, the injected face, and the locale seat. */
export type InboxPanelProps =
  PropsRuntime<'sidebar.workspaces'>
  & InjectFace<InboxInjected>
  & PropsLocale<'inbox'>

export type { InboxState, InboxWorkerRow } from './inbox-controller.ts'
