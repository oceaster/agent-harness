/**
 * Inbox plugin, browser half. ONE registration: InboxPanel fills the sidebar
 * shell's `sidebar.workspaces` hole — the browsing region below the top
 * controls and above the sidebar foot.
 *
 * The region is now the whole navigation surface: one persistent row per agent
 * the signed-in person may use, with Clear as the row menu's only action. The
 * session list, the New Session button, the workspace browser and the hero
 * workspace chip are gone from this deployment (see the package README), so
 * nothing here reads `session.list` to decide what to show and nothing here
 * creates a session: every conversation this panel shows was resolved by the
 * inbox API for (person, agent).
 *
 * The rows come from the server, which is the only side that knows who is
 * asking: the plugin carries no household roster, no agent ids, and no
 * per-agent colours or display names.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.workspaces' entry).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { createInboxApi, type InboxApi } from './inbox-api.ts'
import { InboxController } from './inbox-controller.ts'
import { InboxPanel } from './InboxPanel.tsx'
import { en, zh, type InboxKey } from './locales.ts'

export type { InboxAgentRow, InboxFailureCode } from './inbox-api.ts'
export type { InboxNoticeCode, InboxState, InboxStatus } from './inbox-controller.ts'
export type { InboxInjected, InboxPanelProps } from './slots.ts'
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
 *
 * `sessions` is the navigation seam: the conversation a row opens is selected
 * through the sessions service (see inbox-controller.ts).
 */
export const inject = ['slots', 'sessions', 'locale']

/**
 * Register the inbox panel once the sidebar declares the hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-inbox: dictionaries')

  const api: InboxApi = createInboxApi()
  // The navigation seam, assembled explicitly. `list`, `open` and `clear` are
  // the typed ISessions face; `refresh` is not — the runtime keeps the
  // wire-pump verbs on the concrete SessionRuntime it provides as
  // `ctx.sessions`, so this is the one place that reaches for it.
  const sessions = ctx.sessions as typeof ctx.sessions & { refresh?: () => Promise<void> }
  const refresh = sessions.refresh
  // A client runtime without the verb would break the open path on the first
  // click; name that failure at registration instead of hiding it until then
  // (see the package README: the typed face does not declare it on purpose).
  if (typeof refresh !== 'function') {
    throw new Error('the client runtime no longer exposes sessions.refresh; the inbox open path depends on it')
  }
  const controller = new InboxController({
    api,
    sessions: {
      list: sessions.list,
      open: (id) => { sessions.open(id) },
      clear: () => { sessions.clear() },
      refresh: async (): Promise<void> => {
        await refresh.call(sessions)
      },
    },
  })

  // The boot read must never throw into cordis: a rejected inbox API is a
  // visible row with a retry control, and an unreachable server is the same
  // failure as a refused one.
  ctx.effect(() => {
    void controller.load()
    // Rows' running/blank badges follow the session list the browser already
    // receives, so no polling is involved. A reconnect re-reads the inbox once
    // (the server is the authority on the roster and on last activity).
    const stopFrames = controller.followSessions()
    const stopReset = ctx.on('connection/reset', () => { void controller.load() })
    return () => {
      stopFrames()
      stopReset()
    }
  }, 'ui-inbox: inbox reads')

  const injected = () => ({
    hooks: { inbox: controller.store },
    load: () => { void controller.load() },
    open: (agent: string) => { void controller.open(agent) },
    clear: (agent: string) => { void controller.clear(agent) },
  })

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    { name: 'sidebar.workspaces', locale: NS, inject: injected },
    InboxPanel,
  ))
}
