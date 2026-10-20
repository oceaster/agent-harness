/**
 * Inbox slot contract (spike prototype): the injected business face the panel
 * renders, plus the composed props alias. The `sidebar.workspaces` entry itself
 * is declared by ui-sidebar (imported type-only for its SlotMap merge).
 */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.workspaces' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** One inbox row: the agent, its display title, and the conversation e-server resolved. */
export interface InboxRow {
  /** Agent id (a preset id): delta, darwin, diana. */
  agent: string
  /** Display title for the row. */
  title: string
}

/** Registrant-private injected share (arrives via the register inject factory). */
export interface InboxInjected {
  /** Rows to render, in roster order. */
  rows: readonly InboxRow[]
  /** Open (or start) the conversation for this row. */
  open: (row: InboxRow) => void
  /** Clear this row's conversation (prototype: marker only). */
  clear: (row: InboxRow) => void
}

/** Full component props: the slot's runtime share, the injected face, and the locale seat. */
export type InboxPanelProps = PropsRuntime<'sidebar.workspaces'> & InboxInjected & PropsLocale<'inbox'>
