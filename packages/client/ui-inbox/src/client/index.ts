/**
 * Inbox plugin, browser half. ONE registration: InboxPanel fills the sidebar
 * shell's `sidebar.workspaces` hole — the browsing region between the New
 * Session button and the sidebar foot (declared by ui-sidebar).
 *
 * SPIKE PROTOTYPE (branch spike/inbox-ui, throwaway): the rows are a fixed
 * list supplied by the apply closure, NOT live data. It exists to prove three
 * things the sprint depends on: a brand-new package can be composed into the
 * web bundle, it reaches the browser as a loaded client plugin, and it can
 * occupy `sidebar.workspaces` while ui-workspace's row is disabled.
 *
 * Deliberately fixed agent ids: the composed preset roster on this deployment
 * is seven (delta, darwin, diana, standard, code, minimal, cordis) while the
 * household roster is three. Which side filters is an open question for the
 * sprint (doc/INBOX_SPIKE.md), so the prototype does not read
 * `agentPreset.list` at all.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.workspaces' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { InboxRow } from './slots.ts'
import { InboxPanel } from './InboxPanel.tsx'
import { en, zh, type InboxKey } from './locales.ts'

export type { InboxInjected, InboxPanelProps, InboxRow } from './slots.ts'
export type { InboxKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The inbox region's copy. */
    inbox: InboxKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'inbox'

/**
 * Required services (cordis fiber inject). The target slot is declared by the
 * ui-sidebar apply, whose activation order relative to this one is NOT
 * constrained: `dsh.client.inject` edges are informational and neither owner
 * provides a waitable service for the slot. apply therefore waits on the
 * declaration through `slots.inject()` instead of assuming order.
 */
export const inject = ['slots', 'workspaces', 'locale']

/**
 * Prototype rows. A real inbox reads these from the e-server inbox API, which
 * is the only side that knows the authenticated person and their roster.
 */
const ROWS: readonly InboxRow[] = [
  { agent: 'delta', title: 'Delta' },
  { agent: 'darwin', title: 'Darwin' },
  { agent: 'diana', title: 'Diana' },
]

/**
 * Register the inbox panel once the sidebar declares the hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-inbox: dictionaries')

  const injected = (): { rows: readonly InboxRow[]; open: (row: InboxRow) => void; clear: (row: InboxRow) => void } => ({
    rows: ROWS,
    open: (row) => {
      // A real row carries the session id e-server resolved for (person, agent),
      // and opening it is `ctx.sessions.open(sessionId)`. The prototype has no
      // id, so it leaves a marker AND exercises the runtime session-create path
      // (`workspaces.startSession`) to prove that disabling ui-workspace did not
      // break session creation.
      window.document.documentElement.dataset['inboxLastOpen'] = row.agent
      ctx.workspaces.startSession()
    },
    clear: (row) => {
      // Prototype only: writes a marker the acceptance transcript can read.
      // The real Clear calls the host `session.destroy` capability (T1).
      window.document.documentElement.dataset['inboxLastClear'] = row.agent
    },
  })

  // `priority: -1` is the shadowing rank: the single-kind cell renders the
  // lowest priority, so this panel takes the region over while ui-workspace
  // keeps its own registration (and everything else it provides: the hero
  // WorkspaceChip, the picker dialog, the composer unlock). Two registrations
  // at the SAME priority throw, which is why the rank is explicit.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    { name: 'sidebar.workspaces', priority: -1, inject: injected, locale: NS },
    InboxPanel,
  ))
}
