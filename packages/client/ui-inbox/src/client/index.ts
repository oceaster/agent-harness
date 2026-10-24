/**
 * Inbox plugin, browser half. ONE SHELL, TWO INTERFACES: InboxPanel is the
 * Delta entry point's sidebar (agents and Agent Channels), EpsilonPanel is the
 * Epsilon entry point's (Delta's sub-agents), and ChannelPage occupies the
 * center chat tile when a channel row is selected.
 *
 * BOTH INTERFACES ARE MOUNTED, ONE IS VISIBLE. Owen, 2026-10-24: "The
 * Agent-Harness should always be rendered and rendering (or at least in theory)
 * - if closed, it's actually just 'not-visible'." So `sidebar.workspaces` is
 * occupied by ONE component — SurfacePanels.tsx — which owns the switch
 * internally and never re-registers: the slot is single-consumer (the registry
 * throws on a second occupant, and a mid-session re-registration would remount
 * the panel, which is the cost this exists to remove), so the switch is state,
 * not a registration. See that file's header for the decision in full.
 *
 * WHICH INTERFACE, decided two ways that cannot disagree:
 *   - the URL fragment, read once at boot (surface.ts), so a cold load, a
 *     bookmark, a pasted link and a reload land where they always have;
 *   - the parent page's message (surface-controller.ts), so moving between the
 *     two entries in the composed page costs no document load at all. That is
 *     the mechanism; the fragment is the fallback.
 *
 * The region is the whole navigation surface: one persistent row per agent the
 * signed-in person may use, with Clear as the row menu's only action. The
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
import { SurfacePanels } from './SurfacePanels.tsx'
import { SurfaceController } from './surface-controller.ts'
import { watchFrameShown } from './frame-shown.ts'
import { en, zh, type InboxKey } from './locales.ts'
import { bootIntentOf, type BootIntent } from './surface.ts'

export type { InboxAgentRow, InboxFailureCode } from './inbox-api.ts'
export type { InboxNoticeCode, InboxState, InboxStatus } from './inbox-controller.ts'
export type { InboxInjected, InboxPanelProps } from './slots.ts'
export type { InboxKey } from './locales.ts'
export type { BootIntent, HarnessSurface, OpenIntent } from './surface.ts'
export type { SurfaceSnapshot } from './surface-controller.ts'
export type { FrameShown } from './frame-shown.ts'
export {
  CONVERSATION_FRAGMENT, EPSILONS_FRAGMENT, OPEN_MESSAGE, READY_MESSAGE, ROUTE_MESSAGE,
  bootIntentOf, isHarnessSurface, openIntentOf, surfaceOf,
} from './surface.ts'
export { SurfaceController, parentOriginOf } from './surface-controller.ts'

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
 * Run a poller only while its subject is on screen.
 *
 * THE BUDGET, stated once: a harness surface that is kept alive must cost
 * nothing while hidden (the ticket's rejection criterion). A `setInterval` left
 * running is not free even when its body returns early — and this body would not
 * return early, it would fetch. So the timer starts when the predicate turns
 * true, is cleared the moment it turns false, and `start` runs one read
 * immediately: coming back to a surface must not show what it showed before it
 * was hidden ("a paused/stale read is a bug").
 * @param subscriptions - sources whose change may flip the predicate.
 * @param enabled - whether the poller should currently run.
 * @param start - arms the poller; returns the disposer that disarms it.
 * @returns disposer removing both the subscriptions and any armed poller.
 */
function whileEnabled(
  subscriptions: readonly { subscribe: (listener: () => void) => () => void }[],
  enabled: () => boolean,
  start: () => () => void,
): () => void {
  let teardown: (() => void) | null = null
  const sync = (): void => {
    if (enabled()) {
      if (teardown === null) teardown = start()
      return
    }
    if (teardown === null) return
    const stop = teardown
    teardown = null
    stop()
  }
  const stops = subscriptions.map(source => source.subscribe(sync))
  sync()
  return () => {
    for (const stop of stops) stop()
    if (teardown !== null) {
      const stop = teardown
      teardown = null
      stop()
    }
  }
}

/**
 * Register the sidebar for this page load's interface once the shell declares
 * the hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-inbox: dictionaries')

  // THE ADDRESS, read once, from the URL fragment, before anything is
  // registered. A fragment never reaches the server and it survives the page
  // that wraps this app in a frame, so a reload, a bookmark and a pasted link
  // all land in the same interface. `bootIntentOf` owns both words (`#epsilons`
  // and `#c/<agent>`); see surface.ts for why they are a fragment.
  //
  // It seeds the controller rather than deciding the mount, because the parent
  // may move this app by message afterwards — the fragment is where a cold load
  // starts, not where the app stays.
  const intent: BootIntent = bootIntentOf(globalThis.location?.hash ?? '')
  const surfaces = new SurfaceController(intent)

  // Is the app on screen at all? A hidden frame is not a surface, and every
  // repeat read below asks this before spending a request (frame-shown.ts).
  const shown = watchFrameShown()
  ctx.effect(() => () => { shown.dispose() }, 'ui-inbox: frame visibility')

  const api: InboxApi = createInboxApi()
  const channels = new ChannelController()
  ctx.effect(() => whileEnabled(
    [surfaces.store, shown],
    () => surfaces.surface === 'inbox' && shown.getSnapshot(),
    () => {
      // Channels belong to the inbox interface: the epsilon sidebar paints no
      // channel row, so polling their history there would spend a request per
      // person per 2s on a surface nobody is reading. The read on activation is
      // the other half of the same rule — the list and the open transcript are
      // re-read the moment the interface is back, never left stale.
      void channels.load()
      if (channels.store.getSnapshot().selected !== null) void channels.refresh()
      const timer = setInterval(() => {
        const state = channels.store.getSnapshot()
        if (state.error !== null && state.selected === null) void channels.load()
        else void channels.refresh()
      }, 2000)
      return () => { clearInterval(timer) }
    },
  ), 'ui-inbox: agent channels')
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
    // interface would paint a channel page where the sub-agent list lives — and
    // it loses to an ADDRESSED conversation for the same reason. `#c/<agent>` is
    // somebody saying which conversation they want; restoring the channel they
    // last read would paint a channel page over it and make the deep link look
    // broken. The explicit address wins, and this is the only place that has to
    // know it.
    if (intent.surface !== 'inbox' || intent.conversation !== null) return () => {}
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
  // One way to move the pane onto an agent's conversation, shared by the sidebar
  // row's click (through `injected.open` below) and by an addressed boot or
  // message (`#c/<agent>` on the fragment, `dsh:open` on the wire): the channel
  // page is closed first, so a channel a person was reading cannot stay painted
  // under a conversation they just asked for.
  const openConversation = (agent: string): void => {
    channels.close()
    ctx.layout.openPage(null)
    void controller.open(agent)
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

  // THE ADDRESSED CONVERSATION, from either door. When the fragment named one
  // (`#c/<agent>`, which the e-server top bar's menu writes into the frame src)
  // or the parent's message did (`dsh:open`, the same word on the wire), this
  // opens it — the same `open(agent)` a click runs, so a deep link, a message
  // and a click cannot disagree.
  //
  // It waits for the rows rather than for a single `load()` call: the boot read
  // may already be in flight (a repeated `load()` returns immediately), and
  // opening an agent whose row has not arrived yet would be opening it before we
  // know whether this person is allowed to. `ready` is the answer — a row means
  // open, no row means this person does not have that agent and the front page
  // stands, silently, because nothing failed. `refused` is the same silence with
  // no retry behind it; an `error` keeps waiting, since the 2s poll below is a
  // real retry and a deep link should not depend on which boot beat which.
  //
  // Two triggers, one path: a rows write (the roster arriving) and a message
  // (the parent asking for a conversation mid-session). The request is CONSUMED
  // when it is answered, so a later rows refresh can never re-open it over a
  // person's own navigation.
  ctx.effect(() => {
    const attempt = (): void => {
      if (!surfaces.hasConversationRequest()) return
      const snapshot = controller.store.getSnapshot()
      // Not an answer yet: the read is in flight, or it failed and the 2s poll
      // below is the retry that may still make this address work.
      if (snapshot.status === 'loading' || snapshot.status === 'error') return
      const agent = surfaces.takeConversation()
      if (agent === null) return
      if (snapshot.status !== 'ready') return
      const row = snapshot.rows.find(item => item.agent === agent)
      if (row === undefined || row.enabled === false) return
      openConversation(agent)
    }
    const stopRows = controller.store.subscribe(() => { attempt() })
    const stopRequests = surfaces.onConversationRequest(() => { attempt() })
    attempt()
    return () => { stopRows(); stopRequests() }
  }, 'ui-inbox: addressed conversation')

  // The epsilon interface's roster: read at boot and on the tick that already
  // re-reads the inbox. The inbox interface never asks: no request, no catalog,
  // no rows. `readWorkers` is the one spelling of that read.
  const readWorkers = (): void => { void controller.loadWorkers() }

  // The boot read must never throw into cordis: a rejected inbox API is a
  // visible row with a retry control, and an unreachable server is the same
  // failure as a refused one. The BOOT reads are unconditional — a panel with no
  // rows has nothing to paint, and an addressed conversation needs the roster
  // before it may open anything — but every REPEAT read is gated on the app
  // being on screen.
  ctx.effect(() => {
    void controller.load()
    if (intent.surface === 'epsilons') void (async () => { await controller.load(); readWorkers() })()
    // Rows' running/blank badges follow the session list the browser already
    // receives, so no polling is involved. A reconnect re-reads the inbox once
    // (the server is the authority on the roster and on last activity).
    const stopFrames = controller.followSessions()
    const stopReset = ctx.on('connection/reset', () => {
      void controller.load()
      if (surfaces.surface === 'epsilons') readWorkers()
    })
    // Switching TO the epsilon interface reads Delta's roster NOW, not on the
    // next tick: those rows are the whole reason that interface is showing, and
    // they are the one part of the store the 2s inbox read does not refresh.
    const stopSurface = surfaces.store.subscribe(() => {
      if (surfaces.surface === 'epsilons') readWorkers()
    })
    const stopPoll = whileEnabled([shown], () => shown.getSnapshot(), () => {
      // On screen again: one read, immediately, so a paused poll is never a
      // stale panel (the tab went to the background, or the frame was covered).
      void controller.load()
      if (surfaces.surface === 'epsilons') readWorkers()
      let checking = false
      const timer = setInterval(async () => {
        if (checking) return
        checking = true
        try {
          await controller.load()
          // Delta's roster is re-read on the tick that just re-read the inbox:
          // the parent session can be created by this very read (a person's
          // first visit), and a worker that started or finished is membership
          // the harness broadcasts for the catalogs the runtime holds — this
          // keeps the held one current for the interface that shows it.
          if (surfaces.surface === 'epsilons') readWorkers()
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
      return () => { clearInterval(timer) }
    })
    return () => {
      stopPoll()
      stopFrames()
      stopReset()
      stopSurface()
    }
  }, 'ui-inbox: inbox reads')

  // THE WIRE, and the only place this app listens to its parent. The page that
  // wraps the harness keeps ONE frame with ONE `src` and switches what the app
  // shows by message, so moving between Delta and Epsilons costs no document
  // load. Installed from this scope, so unloading the fiber takes the listener
  // with it; a page whose parent is itself (opened directly) attaches to
  // nothing and keeps its boot read.
  ctx.effect(() => surfaces.attach(), 'ui-inbox: parent messages')

  const injected = () => ({
    hooks: { inbox: controller.store, channels: channels.store },
    sources: { inbox: controller.store, channels: channels.store },
    surface: surfaces.store,
    load: () => { void controller.load(); void channels.load(); void channels.refresh() },
    // Every verb a person can reach is also a ROUTE: the parent is told where
    // they went (`dsh:route`), so the browser URL and the menu's selected entry
    // follow them without anything loading. A channel and a worker have no
    // address of their own (the addresses name an agent), so those report the
    // interface and no conversation.
    openChannel: (id: string) => {
      void channels.open(id)
      ctx.layout.openPage('agent-channel')
      surfaces.announce('inbox', null)
    },
    clearChannel: (id: string) => { void channels.clear(id) },
    open: (agent: string) => { openConversation(agent); surfaces.announce('inbox', agent) },
    loadWorkers: () => { readWorkers() },
    openWorker: (id: string) => { controller.openWorker(id); surfaces.announce('epsilons', null) },
    clear: (agent: string) => { void controller.clear(agent) },
  })

  ctx.slots.inject('conversation.page', () => ctx.slots.register(
    { name: 'conversation.page', id: 'agent-channel', locale: NS, inject: () => ({
      hooks: { channels: channels.store }, refreshChannel: () => { void channels.refresh() },
    }) },
    ChannelPage,
  ))

  // ONE registrant, and it stays one registrant for the life of the page:
  // `sidebar.workspaces` is a single-slot hole, so the switch between the two
  // interfaces is the occupant's own state (SurfacePanels.tsx) — never a second
  // registration, and never a re-registration mid-session, which would remount
  // the panel that this whole design keeps alive.
  ctx.slots.inject('sidebar.workspaces', () => ctx.slots.register(
    { name: 'sidebar.workspaces', locale: NS, inject: injected },
    SurfacePanels,
  ))
}
