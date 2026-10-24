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
import type { SurfaceSnapshot } from './surface-controller.ts'

/** Registrant-private injected share (arrives via the register inject factory). */
export interface InboxInjected {
  hooks: {
    /** The controller's whole snapshot: rows, phases, per-row busy and notices. */
    inbox: SnapshotStore<InboxState>
    /** Permitted channels and the selected channel history. */
    channels: SnapshotStore<ChannelState>
  }
  /**
   * The same two sources, unbound, for the OCCUPANT of the slot.
   *
   * A registered component receives `hooks` already bound to one hook per
   * source (`bindInjectHooks` runs once per entry), so a panel cannot decide
   * whether to listen. The occupant renders both interfaces of the one shell and
   * must hand each of them a hook that goes quiet while it is hidden, which
   * needs the bare source — see surface-gate.ts and SurfacePanels.tsx.
   */
  sources: {
    /** The inbox controller's snapshot source. */
    inbox: SnapshotStore<InboxState>
    /** The channel controller's snapshot source. */
    channels: SnapshotStore<ChannelState>
  }
  /**
   * Which interface the parent asked for, and whether it drives this app at all
   * (in which case both interfaces stay mounted). See surface-controller.ts.
   */
  surface: SnapshotStore<SurfaceSnapshot>
  /** Read (or re-read) the caller's inbox. */
  load: () => void
  /** Open one row's conversation through the inbox API. */
  open: (agent: string) => void
  /**
   * Read (or re-read) Delta's sub-agent roster: the catalog of the signed-in
   * person's Delta conversation, whatever the pane is showing. The epsilon
   * interface calls this at boot and on its poll.
   */
  loadWorkers: () => void
  /**
   * Open one of Delta's sub-agents through the catalog-derived address its row
   * carries. Makes no request of its own: the runtime's `openSubagent` moves the
   * selection, and the conversation it then paints is the harness's own
   * read-only one.
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
export type { HarnessSurface } from './surface.ts'
export type { SurfaceSnapshot } from './surface-controller.ts'
