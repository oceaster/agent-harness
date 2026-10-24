/**
 * Inbox plugin, browser half. ONE SHELL, TWO INTERFACES: InboxPanel fills the
 * sidebar browsing region for the Delta entry point, EpsilonPanel fills the same
 * region for the Epsilon one (Delta's sub-agents), and ChannelPage occupies the
 * center chat tile when a channel row is selected.
 *
 * WHICH ONE IS MOUNTED IS DECIDED ONCE, AT BOOT, FROM THE URL FRAGMENT — see
 * surface.ts for the mechanism and why a fragment. `sidebar.workspaces` is a
 * single-slot hole, so exactly one of the two components is registered: the
 * inbox interface has no sub-agent rows in its tree at all, and the epsilon
 * interface has no agent rows or channel section in its tree at all. That
 * absence is the point (Owen: "2 separate interfaces BUT SAME SAME, DIFFERENT,
 * BUT SAME"), and it is what makes the composed check able to prove the mode by
 * which component rendered, rather than by counting rows.
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
import { EpsilonPanel } from './EpsilonPanel.tsx'
import { en, zh, type InboxKey } from './locales.ts'
import { surfaceOf, type HarnessSurface } from './surface.ts'

export type { InboxAgentRow, InboxFailureCode } from './inbox-api.ts'
export type { InboxNoticeCode, InboxState, InboxStatus } from './inbox-controller.ts'
export type { InboxInjected, InboxPanelProps } from './slots.ts'
export type { InboxKey } from './locales.ts'
export type { HarnessSurface } from './surface.ts'
export { EPSILONS_FRAGMENT, surfaceOf } from './surface.ts'

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
 * Register the sidebar for THIS page load's interface once the shell declares
 * the hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-inbox: dictionaries')

  // THE MODE. Read once, from the URL fragment, before anything is registered:
  // a mode that could change under a mounted panel would have to re-register the
  // single `sidebar.workspaces` slot mid-session, and the two entries are
  // separate links anyway — switching interfaces is a page load, which is also
  // what keeps a link shareable. `surfaceOf` owns the fragment's spelling.
  const surface: HarnessSurface = surfaceOf(globalThis.location?.hash ?? '')

  const api: InboxApi = createInboxApi()
  const channels = new ChannelController()
  ctx.effect(() => {
    // Channels belong to the inbox interface: the epsilon sidebar paints no
    // channel row, so polling their history there would spend a request per
    // person per 2s on a surface nobody is reading.
    if (surface !== 'inbox') return () => {}
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
    // Where-you-were is per interface: a channel restored onto the epsilon
    // interface would paint a channel page where the sub-agent list lives.
    if (surface !== 'inbox') return () => {}
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
      // The sub-agent half of the same seam: one child of the open
      // conversation, addressed exactly as that conversation's catalog listed
      // it. The runtime stays the authority on which children are openable.
      openSubagent: (address) => { sessions.openSubagent(address) },
      // Delta's catalog, pulled by parent session id: the epsilon roster is the
      // person's Delta conversation whether or not it is the open one.
      refreshSubagents: async (parentSessionId) => { await sessions.refreshSubagents(parentSessionId) },
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
    // The epsilon interface's roster: read once at boot, after the inbox read
    // that resolves WHICH session it is (the Delta row's own), and then on the
    // same 2s tick as the inbox below. The inbox interface never asks: no
    // request, no catalog, no rows.
    const readWorkers = (): void => { void controller.loadWorkers() }
    if (surface === 'epsilons') void (async () => { await controller.load(); readWorkers() })()
    // Rows' running/blank badges follow the session list the browser already
    // receives, so no polling is involved. A reconnect re-reads the inbox once
    // (the server is the authority on the roster and on last activity).
    const stopFrames = controller.followSessions()
    const stopReset = ctx.on('connection/reset', () => { void controller.load(); if (surface === 'epsilons') readWorkers() })
    let checking = false
    const timer = setInterval(async () => {
      if (checking) return
      checking = true
      try {
        await controller.load()
        // Delta's roster is re-read on the tick that just re-read the inbox: the
        // parent session can be created by this very read (a person's first
        // visit), and a worker that started or finished is membership the
        // harness broadcasts for the catalogs the runtime holds — this keeps the
        // held one current for the interface that shows it.
        if (surface === 'epsilons') readWorkers()
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
    loadWorkers: () => { void controller.loadWorkers() },
    openWorker: (id: string) => { controller.openWorker(id) },
    clear: (agent: string) => { void controller.clear(agent) },
  })

  ctx.slots.inject('conversation.page', () => ctx.slots.register(
    { name: 'conversation.page', id: 'agent-channel', locale: NS, inject: () => ({
      hooks: { channels: channels.store }, refreshChannel: () => { void channels.refresh() },
    }) },
    ChannelPage,
  ))

  // ONE registrant, chosen by the mode: `sidebar.workspaces` is a single-slot
  // hole, which is exactly the shape "one shell, two interfaces" has. The
  // interface that is not this page load's is not mounted, not hidden: its
  // markup is absent from the DOM.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    { name: 'sidebar.workspaces', locale: NS, inject: injected },
    surface === 'epsilons' ? EpsilonPanel : InboxPanel,
  ))
}
