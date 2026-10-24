/**
 * Inbox controller: the panel's whole state machine, and the ONE place that
 * knows how a click turns into the open conversation.
 *
 * Data flow, one direction: the controller owns a snapshot store, the apply
 * closure registers it under the inject `hooks` compartment (`useInbox`), and
 * the panel renders from it and writes only through the inject callbacks. No
 * React, no ctx, no module-level instances — the class is constructed inside
 * `apply`, so plugin reloads get a fresh controller.
 *
 * THE NAVIGATION SEAM (measured in the browser fixture, see README): the
 * conversation a row opens is the session id the server returned, selected
 * through the client runtime's sessions service — `sessions.open(id)`. That
 * service refuses an id its list does not carry (`sessions.select: unknown
 * session`), and the inbox is an out-of-band write: the e-server origin
 * creates the conversation on the harness host, which broadcasts
 * `host/session-added`, and the client's list learns about it on that frame.
 * So a click waits for the returned id to appear in `sessions.list` (a
 * subscription, not a poll) and only then selects it. An id that never
 * arrives is reported as a row failure instead of a throw.
 */
import type {
  SessionId, SessionListState, SessionSummary, SnapshotStore, SubagentAddress,
} from '@deepseek-ai/dsh-client-runtime/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type {
  InboxAgentRow, InboxApi, InboxFailureCode, InboxPerson,
} from './inbox-api.ts'

/**
 * How long a click waits for the opened conversation to reach the client's
 * session list before reporting that it could not be shown. The frame rides
 * the same connection the click just used, so this is generous on purpose: a
 * slow answer must not turn into a wrong row state.
 */
const LISTED_TIMEOUT_MS = 10_000

/**
 * A per-row outcome the panel has copy for: any API failure, plus the two
 * failures only the client can observe.
 *
 * - `clear-refused`: the API answered 200 with `cleared: false` — the
 *   conversation still exists and the row must stay populated.
 * - `session-not-listed`: open succeeded but the returned session never
 *   reached the client's session list, so the pane cannot show it.
 * - `worker-unavailable`: a sub-agent row was clicked after the live catalog
 *   stopped calling it a healthy child, so the runtime refused the address.
 */
export type InboxNoticeCode =
  | InboxFailureCode
  | 'clear-refused'
  | 'session-not-listed'
  | 'worker-unavailable'

/**
 * One row of the sub-agent roster: a child of the conversation the runtime has
 * open, exactly as that conversation's own catalog describes it.
 *
 * The roster is the ENTRY POINT, never a second transcript: every value here
 * comes from the harness (`subagentsByParent`), and the only thing this panel
 * adds is the household's name for a worker — `index` is rendered as
 * "Epsilon 3" once, and nowhere else, while `label` is the durable creation
 * label the harness recorded (what the worker was asked to do).
 */
export interface InboxWorkerRow {
  /** Durable child session id; the address half `openSubagent` needs. */
  readonly id: SessionId
  /** The direct parent session the catalog was read for. */
  readonly parentId: SessionId
  /** 1-based position among this parent's direct children, in catalog order. */
  readonly index: number
  /** Durable creation label (the delegation's task), absent when none was recorded. */
  readonly label?: string
  /** The child's Agent driver is sampling right now. */
  readonly running: boolean
  /**
   * Continuation mode, absent for a diagnostic row: the runtime addresses a
   * child by its mode, so a row without one cannot be opened.
   */
  readonly mode?: 'one-shot' | 'continuable'
  /** The harness could not identify this child, so its history is unreadable. */
  readonly damaged: boolean
}

/** Whole-panel load state. `error` keeps any rows from an earlier successful read. */
export type InboxStatus = 'loading' | 'ready' | 'error' | 'refused'

/** The panel's snapshot. */
export interface InboxState {
  /** Loading, ready, or a failed read with a retry control. */
  status: InboxStatus
  /** The signed-in person the server resolved; null until the first read lands. */
  person: InboxPerson | null
  /** One row per agent, in the server's order — never merged, hidden, or invented. */
  rows: readonly InboxAgentRow[]
  /** Failure of the last list read; rows may still be present beside it. */
  loadError: InboxFailureCode | null
  /** Agents whose open/clear call is in flight (a row shows it; repeat clicks no-op). */
  busy: readonly string[]
  /** The last failed action per agent, cleared by that agent's next action. */
  notices: Readonly<Record<string, InboxNoticeCode>>
  /**
   * Agent whose conversation the runtime has open, for the row highlight.
   * DERIVED, never owned: {@link InboxController.reconcile} recomputes it from
   * `sessions.list.current` on every frame, so the row that claims to be
   * current is always the row of the session the pane actually paints. That is
   * what makes a reload land on the same conversation — the restored session
   * arrives from the runtime's persisted selection, with no click to record it
   * here.
   */
  openAgent: string | null
  /**
   * Running conversations below each row's own session, at any depth, keyed by
   * agent. An absent agent has none — that is the zero case, never a stored 0.
   */
  activeSubagents: Readonly<Record<string, number>>
  /**
   * The sub-agents of the conversation the runtime has open, in the order the
   * harness listed them. EMPTY when nothing is open, when the open session has
   * no children, and while its catalog is still loading — absence is "no
   * roster", never "no workers", because the roster is only ever the catalog
   * the harness served.
   *
   * This is the door and nothing more: each row is a navigable address into
   * the harness's own read-only conversation, which is where a person reads a
   * worker. Nothing here draws a transcript.
   */
  workers: readonly InboxWorkerRow[]
  /**
   * Session id of the conversation the pane paints, for the worker row
   * highlight. Same derivation as `openAgent`, which stays null while a worker
   * is open because no agent row owns a sub-agent session.
   */
  openWorkerId: SessionId | null
  /**
   * The last refused sub-agent click, keyed by the child session id it named.
   * Cleared by that row's next click.
   */
  workerNotice: { id: SessionId; code: InboxNoticeCode } | null
}

/** Initial snapshot: nothing read yet. */
const INITIAL: InboxState = {
  status: 'loading',
  person: null,
  rows: [],
  loadError: null,
  busy: [],
  notices: {},
  openAgent: null,
  activeSubagents: {},
  workers: [],
  openWorkerId: null,
  workerNotice: null,
}

/**
 * The sessions-service slice this plugin needs — the whole navigation seam.
 * `ISessions` satisfies it structurally; tests supply a fake.
 *
 * `refresh` is the one member the outward `ISessions` face does not type (the
 * runtime keeps the wire-pump verbs on the concrete `SessionRuntime`, which is
 * what it provides as `ctx.sessions`). apply passes it explicitly rather than
 * widening anyone's public interface: without it, `open()` refuses an id the
 * client's mirror has not learned yet, and a conversation e-server created
 * server-to-server is exactly that id.
 */
export interface InboxSessionPort {
  /**
   * The session list snapshot source: `ids` and `current`, plus `byId`, whose
   * summaries carry each session's `running`, `blank`, `parentId` and `origin`.
   * The per-session map is what makes a row's subagent count possible, so a
   * stand-in that carries only ids leaves every count at zero.
   */
  readonly list: { getSnapshot: () => SessionListState; subscribe: (fn: () => void) => () => void }
  /** Pull the host's session list into the mirror (`sessions.refresh()`). */
  refresh?: () => Promise<void>
  /** Select a listed session as the open conversation (throws on an unknown id). */
  open: (id: SessionId) => void
  /**
   * Select one catalog-addressed child as the open conversation.
   *
   * The runtime is the authority on which children are openable: it refuses an
   * address its live catalog does not call a healthy child, which is why the
   * roster rows carry the mode straight out of that catalog rather than
   * guessing one. Throws on a refused address; the caller reports it on the row.
   */
  openSubagent: (address: SubagentAddress) => void
  /** Clear the selection, returning the pane to the no-session state. */
  clear: () => void
}

/** Controller dependencies. */
export interface InboxControllerOptions {
  /** The inbox wire client. */
  api: InboxApi
  /** The sessions service (the navigation seam). */
  sessions: InboxSessionPort
  /** Override the wait for the opened session to reach the session list. */
  listedTimeoutMs?: number
  /** Clock for the wait timer (tests drive it synchronously). */
  setTimer?: (callback: () => void, ms: number) => unknown
  /** Counterpart of `setTimer`. */
  clearTimer?: (handle: unknown) => void
}

/** Wait for `sessionId` to appear in a session-list source. */
function whenListed(
  sessions: InboxSessionPort,
  sessionId: string,
  timeoutMs: number,
  setTimer: (callback: () => void, ms: number) => unknown,
  clearTimer: (handle: unknown) => void,
): Promise<boolean> {
  const listed = (): boolean => sessions.list.getSnapshot().ids.includes(sessionId as SessionId)
  if (listed()) return Promise.resolve(true)
  return new Promise<boolean>((resolve) => {
    let settled = false
    let unsubscribe: () => void = () => {}
    const finish = (value: boolean): void => {
      if (settled) return
      settled = true
      unsubscribe()
      clearTimer(timer)
      resolve(value)
    }
    unsubscribe = sessions.list.subscribe(() => { if (listed()) finish(true) })
    const timer = setTimer(() => { finish(false) }, timeoutMs)
  })
}

/** A row with the fields one open/clear answer owns. */
function patchRow(
  rows: readonly InboxAgentRow[],
  agent: string,
  patch: Partial<Omit<InboxAgentRow, 'agent' | 'name'>>,
): readonly InboxAgentRow[] {
  return rows.map(row => (row.agent === agent ? { ...row, ...patch } : row))
}

/** The row set of an agent that has no conversation. */
const FRESH_ROW = { hasConversation: false, sessionId: null, blank: true, lastActivityAt: null } as const

/**
 * Count the conversations below one session that are running right now.
 *
 * The walk follows `SessionSummary.parentId` from the row's own session down, so
 * it reaches any depth and counts only that row's descendants: a subagent of a
 * different agent, or of a session this person does not own, is never counted.
 * @param byId - the client session list's per-session summaries.
 * @param sessionId - the row's own conversation id.
 * @returns how many descendants are running.
 */
function countRunningDescendants(
  byId: Readonly<Record<SessionId, SessionSummary>>,
  sessionId: string,
): number {
  const children = new Map<string, SessionSummary[]>()
  for (const summary of Object.values(byId)) {
    const parent = summary.parentId
    if (parent === undefined) continue
    const siblings = children.get(parent)
    if (siblings === undefined) children.set(parent, [summary])
    else siblings.push(summary)
  }
  // A re-parented or corrupt lineage must not hang the row: each session is visited once.
  const seen = new Set<string>([sessionId])
  let count = 0
  let frontier: SessionSummary[] = children.get(sessionId) ?? []
  while (frontier.length > 0) {
    const next: SessionSummary[] = []
    for (const child of frontier) {
      if (seen.has(child.id)) continue
      seen.add(child.id)
      if (child.running) count += 1
      next.push(...children.get(child.id) ?? [])
    }
    frontier = next
  }
  return count
}

/** Whether two per-agent counts are the same numbers, so an idle frame re-renders nothing. */
function sameCounts(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  const agents = Object.keys(left)
  return agents.length === Object.keys(right).length && agents.every(agent => left[agent] === right[agent])
}

/**
 * The sub-agent roster of one conversation, straight out of that conversation's
 * catalog — the same `subagentsByParent` snapshot the harness's own catalog
 * tree renders, so the two can never list different workers.
 *
 * Direct children only. A worker is opened by selecting it, and the roster then
 * follows the selection one level down, which is how the runtime's catalogs are
 * addressed (one direct parent per address): descending costs one click and
 * ascending is the harness's own hierarchy navigation.
 * @param catalogs - the runtime's per-parent catalogs.
 * @param parentId - the session the pane has open, if any.
 * @returns the roster, empty when there is no catalog for that parent.
 */
function workerRoster(
  catalogs: SessionListState['subagentsByParent'],
  parentId: SessionId | undefined,
): readonly InboxWorkerRow[] {
  if (parentId === undefined) return []
  const catalog = catalogs[parentId]
  if (catalog === undefined) return []
  return catalog.entries.map((entry, position): InboxWorkerRow => {
    const index = position + 1
    if (entry.kind === 'diagnostic') {
      // The harness enumerated the child but cannot identify its record, so
      // there is no mode to address it by: the row is a statement, not a door.
      return { id: entry.id, parentId, index, running: false, damaged: true }
    }
    return {
      id: entry.id,
      parentId,
      index,
      ...entry.label === undefined ? {} : { label: entry.label },
      running: entry.activity === 'running',
      mode: entry.mode,
      damaged: false,
    }
  })
}

/** Whether two rosters are the same rows, so an unchanged catalog re-renders nothing. */
function sameWorkers(
  left: readonly InboxWorkerRow[],
  right: readonly InboxWorkerRow[],
): boolean {
  return left.length === right.length && left.every((row, index) => {
    const other = right.at(index)
    return other !== undefined
      && row.id === other.id
      && row.parentId === other.parentId
      && row.index === other.index
      && row.label === other.label
      && row.running === other.running
      && row.mode === other.mode
      && row.damaged === other.damaged
  })
}

/** Owns the inbox snapshot and every open/clear/list transition. */
export class InboxController {
  /** The snapshot the renderer subscribes to (`useInbox`). */
  readonly store: SnapshotStore<InboxState> = createSnapshotStore(INITIAL)

  private readonly api: InboxApi
  private readonly sessions: InboxSessionPort
  private readonly listedTimeoutMs: number
  private readonly setTimer: (callback: () => void, ms: number) => unknown
  private readonly clearTimer: (handle: unknown) => void
  private loading = false

  /**
   * @param options - wire client, sessions port, and test knobs.
   */
  constructor(options: InboxControllerOptions) {
    this.api = options.api
    this.sessions = options.sessions
    this.listedTimeoutMs = options.listedTimeoutMs ?? LISTED_TIMEOUT_MS
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms))
    this.clearTimer = options.clearTimer ?? ((handle) => { clearTimeout(handle as ReturnType<typeof setTimeout>) })
  }

  /**
   * Keep the rows' live bits honest without polling: the session list already
   * carries `running` and `blank` for every session, and every session's
   * `parentId`, so a frame the harness sends on its own is folded into the
   * matching row and its descendant count costs no request.
   * @returns the unsubscribe handle, for the apply closure's effect.
   */
  followSessions(): () => void {
    return this.sessions.list.subscribe(() => { this.reconcile() })
  }

  /**
   * Fold the session list's running/blank bits into the rows that name those
   * sessions, recount the running conversations below each row, and re-derive
   * which agent is open from the runtime's own selection.
   */
  private reconcile(): void {
    const snapshot = this.store.getSnapshot()
    const { ids, byId, current, subagentsByParent } = this.sessions.list.getSnapshot()
    // The roster is the open conversation's own catalog. The runtime refreshes
    // the SELECTED session's catalog on every membership frame, so this needs
    // no request of its own: a worker that appears or finishes shows up here on
    // the same frame the harness's own catalog tree would show it.
    const workers = workerRoster(subagentsByParent, current)
    const openWorkerId = current ?? null
    // The row highlight follows `sessions.list.current` — the exact value the
    // conversation pane renders — instead of a private click record. A frame
    // therefore always wins, including the boot frame that restores the
    // persisted selection with no click behind it, and a session no row names
    // (a subagent, or another person's conversation) marks no row.
    const openAgent = current === undefined
      ? null
      : snapshot.rows.find(row => row.sessionId === current)?.agent ?? null
    if (snapshot.rows.length === 0) {
      if (openAgent === null && sameWorkers(workers, snapshot.workers)
        && openWorkerId === snapshot.openWorkerId) return
      this.store.set({ ...snapshot, openAgent, workers, openWorkerId })
      return
    }
    let rows = snapshot.rows
    const activeSubagents: Record<string, number> = {}
    for (const row of snapshot.rows) {
      if (row.sessionId === null) continue
      const active = countRunningDescendants(byId, row.sessionId)
      if (active > 0) activeSubagents[row.agent] = active
      if (!ids.includes(row.sessionId as SessionId)) continue
      const summary = byId[row.sessionId as SessionId]
      /* v8 ignore next -- ids and byId are projected together; a listed id has a summary. */
      if (summary === undefined) continue
      if (summary.running === row.running && summary.blank === row.blank) continue
      rows = patchRow(rows, row.agent, { running: summary.running, blank: summary.blank })
    }
    const workerNotice = snapshot.workerNotice !== null
      && !workers.some(row => row.id === snapshot.workerNotice?.id) ? null : snapshot.workerNotice
    if (rows === snapshot.rows && sameCounts(activeSubagents, snapshot.activeSubagents)
      && openAgent === snapshot.openAgent && sameWorkers(workers, snapshot.workers)
      && openWorkerId === snapshot.openWorkerId && workerNotice === snapshot.workerNotice) return
    this.store.set({
      ...snapshot, rows, activeSubagents, openAgent, workers, openWorkerId, workerNotice,
    })
  }

  /**
   * Open one sub-agent of the conversation the pane has open.
   *
   * Nothing is fetched and nothing is created here: the address comes from the
   * row, which came from that conversation's catalog, and the runtime's
   * `openSubagent` is what moves the pane. A worker that the catalog stopped
   * calling healthy between the render and the click is refused by the runtime,
   * and that refusal is said on the row instead of silently doing nothing.
   * @param id - the child session id the clicked row carries.
   */
  openWorker(id: string): void {
    const snapshot = this.store.getSnapshot()
    const row = snapshot.workers.find(worker => worker.id === id)
    if (row === undefined || row.mode === undefined) return
    this.store.set({ ...snapshot, workerNotice: null })
    try {
      this.sessions.openSubagent({
        parentSessionId: row.parentId,
        childSessionId: row.id,
        mode: row.mode,
      })
    } catch {
      this.store.set({ ...this.store.getSnapshot(), workerNotice: { id: row.id, code: 'worker-unavailable' } })
      return
    }
    // The selection moved: re-derive the highlight now rather than waiting for
    // the list frame, exactly as the agent-row open path does.
    this.reconcile()
  }

  /**
   * Read the inbox. A repeated call while one is in flight is dropped rather
   * than queued: the panel's retry control and the boot read must not stack
   * requests. Rows from an earlier read stay on screen while a refresh runs.
   * @returns once the snapshot reflects the server (or its failure).
   */
  async load(): Promise<void> {
    if (this.loading) return
    this.loading = true
    const before = this.store.getSnapshot()
    this.store.set({ ...before, status: before.rows.length === 0 ? 'loading' : 'ready', loadError: null })
    const outcome = await this.api.list()
    this.loading = false
    if (!outcome.ok) {
      // 403 on the list read is a REFUSAL, not a failure: the e-server profile
      // middleware answers it before any inbox route exists (the guest profile
      // does). Retrying cannot change it, so the panel must not offer a retry.
      if (outcome.code === 'forbidden') {
        this.store.set({ ...this.store.getSnapshot(), status: 'refused', rows: [], loadError: null })
        return
      }
      this.store.set({ ...this.store.getSnapshot(), status: 'error', loadError: outcome.code })
      return
    }
    const current = this.store.getSnapshot()
    this.store.set({
      ...current,
      status: 'ready',
      person: outcome.value.person,
      rows: outcome.value.agents,
      loadError: null,
      // A row the server no longer returns is gone from the panel; its notice
      // would otherwise linger against an agent that is not on screen.
      notices: Object.fromEntries(
        Object.entries(current.notices).filter(([agent]) => outcome.value.agents.some(row => row.agent === agent)),
      ),
    })
    // A fresh read is the server's newest word on running/blank; fold in the
    // frames it has already delivered.
    this.reconcile()
  }

  /**
   * Open one row's conversation: `POST /open`, then show the session the
   * server returned. Exactly one request per click — a row whose call is in
   * flight ignores further clicks.
   * @param agent - the row's agent id, verbatim from the server's payload.
   * @returns once the snapshot reflects the outcome.
   */
  async open(agent: string): Promise<void> {
    if (this.store.getSnapshot().busy.includes(agent)
      || this.store.getSnapshot().rows.find(row => row.agent === agent)?.enabled === false) return
    this.startAction(agent)
    const outcome = await this.api.open(agent)
    if (!outcome.ok) {
      this.finishAction(agent, outcome.code)
      return
    }
    const { sessionId, blank, lastActivityAt, created } = outcome.value
    const snapshot = this.store.getSnapshot()
    // No optimistic row highlight here on purpose: the rows follow the
    // runtime's selection (see reconcile), so the highlight moves exactly when
    // `sessions.open` below moves the pane — the painted conversation and the
    // current row cannot disagree, not even for one frame.
    this.store.set({
      ...snapshot,
      rows: patchRow(snapshot.rows, agent, {
        hasConversation: true,
        sessionId,
        blank,
        lastActivityAt,
        // A conversation this call created cannot be running yet; a reused one
        // keeps whatever the last frame said.
        ...created ? { running: false } : {},
      }),
    })
    // The row names a different conversation now, so its descendant count is
    // recomputed rather than inherited from the previous session.
    this.reconcile()
    // The pane can only show a session the client's mirror carries. The inbox
    // writes out of band (the server created the conversation on the host), so
    // the mirror may not know the id yet: pull the host list once, then select.
    // A refresh that fails, and an id that still never appears, are both the
    // same visible outcome — the open failed, so say so on the row.
    let notice: InboxNoticeCode | undefined
    const listed = await this.ensureListed(sessionId)
    if (!listed) {
      notice = 'session-not-listed'
    } else {
      try {
        this.sessions.open(sessionId as SessionId)
        // The selection just moved: re-derive the highlight now rather than
        // waiting for the list frame, so a click is live even before the
        // frames subscription is attached.
        this.reconcile()
      } catch {
        // The list carried the id and lost it before the select: report it
        // rather than throwing out of a click.
        notice = 'session-not-listed'
      }
    }
    this.finishAction(agent, notice)
  }

  /**
   * Make one session id selectable: skip the pull when the mirror already has
   * it, otherwise refresh once and, if a broadcast is merely late, wait a
   * bounded moment for the frame.
   * @param sessionId - the id the open answer named.
   * @returns whether the mirror now lists it.
   */
  private async ensureListed(sessionId: string): Promise<boolean> {
    const isListed = (): boolean => this.sessions.list.getSnapshot().ids.includes(sessionId as SessionId)
    if (isListed()) return true
    if (this.sessions.refresh !== undefined) {
      try {
        await this.sessions.refresh()
      } catch {
        // A failed pull is an open failure, never a reason to select stale
        // state; the caller reports it on the row.
        return false
      }
    }
    if (isListed()) return true
    return whenListed(this.sessions, sessionId, this.listedTimeoutMs, this.setTimer, this.clearTimer)
  }

  /**
   * Destroy one row's conversation: `POST /clear`. The row returns to the
   * fresh state only when the API says the conversation is gone; a refusal (a
   * failed call, or `cleared: false`) leaves the row populated and says so.
   * @param agent - the row's agent id, verbatim from the server's payload.
   * @returns once the snapshot reflects the outcome.
   */
  async clear(agent: string): Promise<void> {
    if (this.store.getSnapshot().busy.includes(agent)
      || this.store.getSnapshot().rows.find(row => row.agent === agent)?.enabled === false) return
    this.startAction(agent)
    const before = this.store.getSnapshot()
    const opened = before.rows.find(row => row.agent === agent)?.sessionId ?? null
    const wasOpen = before.openAgent === agent
    const outcome = await this.api.clear(agent)
    if (!outcome.ok) {
      this.finishAction(agent, outcome.code)
      return
    }
    const value = outcome.value
    const snapshot = this.store.getSnapshot()
    // The payload is the authority on what the conversation IS, including when
    // `cleared` is false: a still-existing conversation is rendered exactly as
    // the server describes it, never as fresh.
    const rowPatch = value.cleared
      ? { ...FRESH_ROW }
      : {
        hasConversation: value.hasConversation,
        sessionId: value.sessionId,
        blank: value.blank,
        lastActivityAt: value.lastActivityAt,
      }
    const clearOpen = value.cleared && (wasOpen || this.isCurrent(opened))
    this.store.set({ ...snapshot, rows: patchRow(snapshot.rows, agent, rowPatch) })
    if (clearOpen) {
      // The conversation is gone: reset the pane instead of leaving a dead
      // session staged, and stop waiting on a session that no longer exists.
      this.sessions.clear()
    }
    // A cleared conversation has no descendants: drop the count with the row
    // instead of waiting for the next session frame to notice. This also
    // re-derives the row highlight from the runtime's (now cleared) selection.
    this.reconcile()
    this.finishAction(agent, value.cleared ? undefined : 'clear-refused')
  }

  /** Whether one session id is the pane's current conversation. */
  private isCurrent(sessionId: string | null): boolean {
    if (sessionId === null) return false
    return this.sessions.list.getSnapshot().current === sessionId
  }

  /** Mark one agent's action in flight and drop its previous notice. */
  private startAction(agent: string): void {
    const snapshot = this.store.getSnapshot()
    const { [agent]: _dropped, ...notices } = snapshot.notices
    this.store.set({
      ...snapshot,
      busy: [...snapshot.busy, agent],
      notices,
    })
  }

  /** Settle one agent's action, recording a failure notice when there is one. */
  private finishAction(agent: string, notice: InboxNoticeCode | undefined): void {
    const snapshot = this.store.getSnapshot()
    this.store.set({
      ...snapshot,
      busy: snapshot.busy.filter(candidate => candidate !== agent),
      notices: notice === undefined ? snapshot.notices : { ...snapshot.notices, [agent]: notice },
    })
  }
}
