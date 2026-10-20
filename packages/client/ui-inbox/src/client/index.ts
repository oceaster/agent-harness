/**
 * Inbox plugin, browser half. InboxPanel fills the sidebar browsing region;
 * ChannelPage occupies the center chat tile when a channel row is selected.
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
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { ChannelPage } from './ChannelPage.tsx'
import { createInboxApi, type InboxApi } from './inbox-api.ts'
import { InboxController } from './inbox-controller.ts'
import { ChannelController } from './channel-controller.ts'
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
export const inject = ['slots', 'sessions', 'locale', 'layout']

/**
 * Register the inbox panel once the sidebar declares the hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-inbox: dictionaries')

  const api: InboxApi = createInboxApi()
  const channels = new ChannelController()
  ctx.effect(() => {
    void channels.load()
    const timer = setInterval(() => {
      if (channels.store.getSnapshot().error !== null && channels.store.getSnapshot().selected === null) void channels.load()
      else void channels.refresh()
    }, 2000)
    return () => { clearInterval(timer) }
  }, 'ui-inbox: agent channels')
  // Where-you-were, channel half. The open channel is durable (ChannelController
  // persists its id), and this plugin is the SINGLE writer of the channel page:
  // the restore selects the channel and calls layout.openPage in one step, so a
  // reload lands on the channel itself instead of painting the agent
  // conversation first and correcting a frame later. Disarmed after the first
  // resolved boot (or when there was nothing to restore) so a later rows
  // refresh can never re-navigate the person; an id the server no longer offers
  // is dropped by the controller and the ordinary conversation default stands,
  // silently, because nothing failed.
  //
  // Triggers are the notification AND the state that is already there, in that
  // order: a rows write that happened before this effect installed is caught by
  // the immediate read, one that happens after it by the subscription. Reading
  // only on the notification is a restore that works when the data happens to
  // arrive while we are watching, which is not a restore. The frame's own boot
  // order is not a dependency either: openPage before the root entry mounts is
  // held by ctx.layout and applied at mount (ui-layout's LayoutController).
  ctx.effect(() => {
    let armed = true
    const restore = (): void => {
      if (!armed || channels.store.getSnapshot().rows.length === 0) return
      armed = false
      void channels.restorePersisted(() => { ctx.layout.openPage('agent-channel') })
    }
    const stop = channels.store.subscribe(() => { restore() })
    restore()
    return () => { stop() }
  }, 'ui-inbox: channel restore')
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
    let checking = false
    const timer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        await controller.load()
        if (channels.store.getSnapshot().selected !== null || document.visibilityState !== 'visible') return
        const current = sessions.list.getSnapshot().current
        const row = controller.store.getSnapshot().rows.find(item => item.sessionId === current)
        if (row === undefined || row.running || row.presence !== 'unread' || row.completion === undefined) return
        const response = await fetch('/v1/browser/inbox/seen', { method: 'POST', credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agent: row.agent, completion: row.completion }),
          signal: AbortSignal.timeout(8000),
        })
        if (response.ok) await controller.load()
      } catch { /* A transient status/read-receipt failure retries on the next poll. */ }
      finally { checking = false }
    }, 2000)
    return () => {
      clearInterval(timer)
      stopFrames()
      stopReset()
    }
  }, 'ui-inbox: inbox reads')

  const injected = () => ({
    hooks: { inbox: controller.store, channels: channels.store },
    load: () => { void controller.load(); void channels.load(); void channels.refresh() },
    openChannel: (id: string) => { void channels.open(id); ctx.layout.openPage('agent-channel') },
    clearChannel: (id: string) => { void channels.clear(id) },
    open: (agent: string) => { channels.close(); ctx.layout.openPage(null); void controller.open(agent) },
    clear: (agent: string) => { void controller.clear(agent) },
  })

  ctx.slots.inject('conversation.page', () => ctx.slots.register(
    { name: 'conversation.page', id: 'agent-channel', locale: NS, inject: () => ({
      hooks: { channels: channels.store }, refreshChannel: () => { void channels.refresh() },
    }) },
    ChannelPage,
  ))

  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    { name: 'sidebar.workspaces', locale: NS, inject: injected },
    InboxPanel,
  ))
}
