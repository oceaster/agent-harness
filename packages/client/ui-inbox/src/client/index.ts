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
import type { SessionId } from '@deepseek-ai/dsh-client-runtime/client'
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
import { SurfaceMemory, planRestore } from './surface-memory.ts'
import { watchFrameShown } from './frame-shown.ts'
import { en, zh, type InboxKey } from './locales.ts'
import { bootIntentOf, type BootIntent, type HarnessSurface } from './surface.ts'

export type { InboxAgentRow, InboxFailureCode } from './inbox-api.ts'
export type { InboxNoticeCode, InboxState, InboxStatus } from './inbox-controller.ts'
export type { InboxInjected, InboxPanelProps } from './slots.ts'
export type { InboxKey } from './locales.ts'
export type { BootIntent, HarnessSurface, OpenIntent } from './surface.ts'
export type { SurfaceSnapshot } from './surface-controller.ts'
export type { SurfacePlace, SurfacePlaceKind, RestorePlan } from './surface-memory.ts'
export type { FrameShown } from './frame-shown.ts'
export {
  CONVERSATION_FRAGMENT, EPSILONS_FRAGMENT, OPEN_MESSAGE, READY_MESSAGE, ROUTE_MESSAGE,
  bootIntentOf, isHarnessSurface, openIntentOf, surfaceOf,
} from './surface.ts'
export { SurfaceController, parentOriginOf } from './surface-controller.ts'
export { SurfaceMemory, PLACE_KINDS, planRestore } from './surface-memory.ts'

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
  // One record per (person, surface): see surface-memory.ts for the shape, the
  // storage and the decision. This plugin is its single writer, exactly as it is
  // the single writer of the channel page.
  const places = new SurfaceMemory()
  /** The person the server resolved, or null before the roster lands. */
  const personOf = (): string | null => controller.store.getSnapshot().person?.id ?? null
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
  // WHERE YOU WERE is per interface and lives in one store (surface-memory.ts);
  // the effect that restores it is installed below, once the sessions seam and
  // the two controllers it reads are in scope.
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
    // THE ADDRESS BECOMES THE MEMORY, in the same tick it is asked for. A row
    // click, a `#c/<agent>` cold load and a `dsh:open` carrying a conversation
    // all arrive here — one door, one write point — so the record can never be
    // written by one of them and missed by another. Written on the ASK rather
    // than on the answer: the click is the selection changing, and a person who
    // switches interfaces while the request is still in flight was still
    // choosing that conversation.
    places.remember(personOf(), 'inbox', 'agent', agent)
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

  // ── WHERE YOU WERE, restored on the way in ────────────────────────────────
  // Owen, 2026-10-24: "when switching between Delta/Epsilon views always default
  // the last known read/write inbox session or agent channel for the Delta view.
  // And default to the last known Epsilon read only session for the Epsilon
  // view." So each interface restores ITS OWN place — one record per (person,
  // surface), shape and storage in surface-memory.ts — every time it becomes
  // visible, and the decision of what to paint is `planRestore`'s (pure, and the
  // one place the ordering rule is written):
  //
  //   - an explicit address beats the record and then becomes it (the write is in
  //     `openConversation`, the door every addressed open comes through);
  //   - nothing is restored before that surface's own data is read;
  //   - a target that no longer resolves falls back to the surface's own default,
  //     silently, and its record is retired.
  //
  // ARMED ONCE PER SHOWING, which is what makes a Delta -> Epsilon -> Delta round
  // trip restore each side exactly once: the arm is consumed by the first answer
  // (painted, dropped as dead, adopted, or overruled by an address) and re-armed
  // only by the next switch TO that surface. No rows refresh, session frame or
  // channel poll can re-navigate somebody who has since moved on.
  //
  // AND THE PAINT IS THE SAME WRITE. The surface store notifies synchronously, so
  // the selection moves in the same tick as the visibility flip: the painted
  // conversation (or channel page) and the sidebar's `aria-current` row cannot
  // disagree, not even for one frame. Nothing here is deferred to an effect.
  ctx.effect(() => {
    const armed: Record<HarnessSurface, boolean> = { inbox: false, epsilons: false }
    let shown = surfaces.surface
    armed[shown] = true
    const attempt = (): void => {
      const surface = surfaces.surface
      if (!armed[surface]) return
      const inbox = controller.store.getSnapshot()
      const channelState = channels.store.getSnapshot()
      const who = personOf()
      const channelIds = channelState.rows.map(row => row.id)
      // The previous build's channel key, adopted once for the person signed in
      // now, so nobody loses the channel they were reading when this lands.
      places.adoptLegacyChannel(who, channelIds)
      const plan = planRestore({
        surface,
        place: places.placeOf(who, surface),
        addressed: surface === 'inbox' ? surfaces.pendingConversation() : null,
        ready: surface === 'inbox' ? inbox.status === 'ready' : inbox.workersState === 'ready',
        rows: inbox.rows,
        channelIds,
        workers: inbox.workers,
        listed: sessions.list.getSnapshot().ids,
        current: sessions.list.getSnapshot().current,
      })
      // Not an answer yet: the data that proves or disproves this record is
      // still in flight. Stay armed and try again on the next write.
      if (plan.action === 'wait') return
      armed[surface] = false
      switch (plan.action) {
        case 'addressed':
          // The explicit address wins, and the open path writes the new record
          // when it applies it. The record does not speak this time at all.
          return
        case 'none':
          return
        case 'adopt':
          // Already where the person left it, because their place lived in the
          // runtime's own persisted selection: remember it now, so the NEXT
          // interface switch has something to come back to. Nothing is painted.
          places.remember(who, surface, plan.kind, plan.id)
          return
        case 'default': {
          // The record's target is gone, or the pane is painting the other
          // interface's selection. Forget the dead address and paint this
          // surface's own default — the Delta welcome screen, or the Epsilon list
          // with nothing open — so the place you just left is never left painted
          // underneath. Nothing failed, so nothing is said.
          places.forget(who, surface)
          channels.close()
          ctx.layout.openPage(null)
          sessions.clear()
          return
        }
        case 'agent':
          // One write: the channel page (a Delta page) is closed and the pane is
          // moved in the same tick the surface became visible. `reconcile`
          // derives the row highlight from the runtime's selection, so the two
          // cannot disagree.
          channels.close()
          ctx.layout.openPage(null)
          try {
            sessions.open(plan.sessionId as SessionId)
          } catch {
            // The mirror lost the id between the check and the select: the
            // surface keeps its default instead of throwing out of a message.
            places.forget(who, surface)
            sessions.clear()
          }
          return
        case 'channel':
          // ui-inbox is the single writer of the channel page, and this is the
          // same one-step pattern a channel row click uses: the channel becomes
          // the selection and the page is named in the same tick, so a reload
          // lands on the channel itself rather than painting the agent
          // conversation first and correcting a frame later.
          void channels.reopen(plan.id, () => { ctx.layout.openPage('agent-channel') })
            .then((outcome) => { if (outcome !== 'opened') places.forget(who, surface) })
          return
        case 'worker':
          // The unit, through the same door a row click uses — and the channel
          // page is closed first, because it belongs to Delta and would otherwise
          // stay painted under the unit the person came back to.
          ctx.layout.openPage(null)
          if (!controller.restoreWorker(plan.id)) {
            places.forget(who, surface)
            sessions.clear()
          }
          return
      }
    }
    // The trigger is the notification AND the state that is already there, in
    // that order: a write that landed before this effect installed is caught by
    // the immediate call, one that lands after it by the subscription. A restore
    // that only works when the data happens to arrive while we are watching is
    // not a restore. Each source is a different half of the answer — the surface
    // (a switch), the inbox store (rows and the roster), the channel store (the
    // channel list), and the session list (what `sessions.open` accepts).
    const stops = [
      surfaces.store.subscribe(() => {
        const next = surfaces.surface
        // A resident flag write is not a move between interfaces.
        if (next === shown) return
        shown = next
        armed[next] = true
        attempt()
      }),
      controller.store.subscribe(() => { attempt() }),
      channels.store.subscribe(() => { attempt() }),
      sessions.list.subscribe(() => { attempt() }),
    ]
    attempt()
    return () => { for (const stop of stops) stop() }
  }, 'ui-inbox: where you were')

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

  /**
   * Clear one row's conversation, and retire the Delta record that names it.
   *
   * A cleared conversation cannot be reopened, so the record would only be
   * dropped as dead on the next visit; retiring it here keeps the store honest
   * and keeps "where you were" from surviving the thing it pointed at. The row
   * is the proof: `sessionId: null` means the server itself said it is gone.
   * @param agent - the row's agent id.
   */
  const clearRow = async (agent: string): Promise<void> => {
    await controller.clear(agent)
    const row = controller.store.getSnapshot().rows.find(item => item.agent === agent)
    if (row === undefined || row.sessionId !== null) return
    const place = places.placeOf(personOf(), 'inbox')
    if (place !== null && place.kind === 'agent' && place.id === agent) places.forget(personOf(), 'inbox')
  }

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
      const row = channels.store.getSnapshot().rows.find(candidate => candidate.id === id)
      void channels.open(id)
      ctx.layout.openPage('agent-channel')
      // Where-you-were for this interface, channel kind: the Delta place is the
      // channel now, so the record stops naming a conversation in one write.
      // Only a row the server listed is recorded — the same rule a click obeys.
      if (row !== undefined) places.remember(personOf(), 'inbox', 'channel', id)
      surfaces.announce('inbox', null)
    },
    clearChannel: (id: string) => { void channels.clear(id) },
    open: (agent: string) => { openConversation(agent); surfaces.announce('inbox', agent) },
    loadWorkers: () => { readWorkers() },
    openWorker: (id: string) => {
      // The channel page belongs to the Delta interface. Leaving it painted
      // under a unit is exactly the "previous surface's selection underneath"
      // this ticket is about: `sessions.openSubagent` moves the selection, but a
      // page the layout still calls current keeps the chat tile.
      ctx.layout.openPage(null)
      const row = controller.store.getSnapshot().workers.find(worker => worker.id === id)
      controller.openWorker(id)
      // Where-you-were for THIS interface: the read-only unit, by the address
      // the row's own `openSubagent` call uses. Only a roster row is recorded.
      if (row !== undefined && row.mode !== undefined) places.remember(personOf(), 'epsilons', 'worker', id)
      surfaces.announce('epsilons', null)
    },
    clear: (agent: string) => { void clearRow(agent) },
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
