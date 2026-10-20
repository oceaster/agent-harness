/**
 * Fork-only lifecycle policy: reap subagent sessions nobody is using.
 *
 * The household asked for dead subagent conversations to be removed without a
 * human clicking Clear on each one, so this host-side pass destroys a subagent
 * session once it has been idle past a threshold. It is a lifecycle concern of
 * the Host, not a conversation feature: no client surface, no turn, no model
 * call, no title, no inbox entry, no budget effect.
 *
 * Three rules, in priority order, and every one of them refuses before it acts:
 *
 * 1. SUBAGENT SESSIONS ONLY. The predicate is the durable header's
 *    `origin: 'subagent'`. Only a spawned child records that field
 *    (`subagent/child-agent.ts: childSessionMeta`, read back from the stored
 *    header here), so a conversation a person created — a top-level session, or
 *    a persistent `<profile>`-per-agent inbox row, which e-server mints through
 *    `session.create` with its own id and no origin — can never match it, no
 *    matter how long it has sat idle. The reaper deliberately knows nothing
 *    about id shapes: the harness stays profile-agnostic, and `origin` is
 *    durable metadata written at spawn, not a naming convention.
 * 2. NEVER TOUCH A SESSION WITH LIVE WORK. A session whose Agent is running, or
 *    whose Agent holds queued work (`inbox.hasPending` — a queued next turn or
 *    pending steering), is skipped whatever its last-event age. A child that a
 *    parent is still using is not idle.
 * 3. REUSE THE DESTROY ROUTINE. The reaper never deletes a log, never disposes
 *    an Agent and never touches a checkpoint itself: it calls the same
 *    `session.destroy` function the RPC calls, so cancel-settle, descendant
 *    collection, workspace/projection cleanup and the commit-point ordering
 *    cannot drift between a person clearing a conversation and a timer doing it.
 *    A refusal from that routine (a turn that will not settle, a lifecycle owned
 *    elsewhere, a backend that cannot delete) is a NORMAL outcome: log the id
 *    and the reason, leave the session exactly as it is, and try again on the
 *    next pass. Nothing forces an outcome, and nothing deletes a log to prove
 *    one.
 *
 * @module @deepseek-ai/dsh-host-apiproxy/subagent-idle-reaper
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionId, SessionHeader } from '@deepseek-ai/dsh-session'
import z from '@deepseek-ai/schemastery'
import type { RpcError } from './api/rpc.ts'

const HOUR_MS = 3_600_000

/**
 * Shipped idle threshold: six hours without a durable log event. Long enough
 * that a child resumed by a person's own afternoon work is never a candidate,
 * short enough that a night's accumulation is gone by morning.
 */
export const DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS = 6 * HOUR_MS

/**
 * Shipped scan cadence: hourly. The threshold is measured in hours, so a
 * shorter cadence buys nothing but IO; a longer one would let a reaped-eligible
 * child linger most of a day. One pass is cheap (it reads only subagent logs
 * that a write-behind flush has not touched recently).
 */
export const DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS = HOUR_MS

/** Smallest accepted threshold: below an hour this stops being housekeeping. */
export const MIN_SUBAGENT_IDLE_REAP_IDLE_MS = HOUR_MS

/** Smallest accepted cadence: a sub-minute scan is a busy-wait, not a scan. */
export const MIN_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS = 60_000

/**
 * The `subagentIdleReap` plugin-config section. Both bounds are enforced by the
 * schema, so a deployment naming zero, a negative value or a sub-hour threshold
 * is refused at boot with the offending path instead of silently running a
 * policy nobody asked for.
 */
export interface SubagentIdleReapConfig {
  /** Idle threshold measured from the durable log's last event. @default 21600000 */
  idleMs: number
  /** Cadence of one scan pass. @default 3600000 */
  scanIntervalMs: number
}

/** Schemastery schema for {@link SubagentIdleReapConfig} (validated at plugin load). */
export const SubagentIdleReapConfigSchema: z<SubagentIdleReapConfig> = z.object({
  idleMs: z.natural().min(MIN_SUBAGENT_IDLE_REAP_IDLE_MS).default(DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS),
  scanIntervalMs: z.natural().min(MIN_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS)
    .default(DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS),
})

/**
 * The one destroy routine, as both callers see it (`session.destroy`'s handler
 * body in `api-proxy.ts`). Success reports the destroyed id and the subagent
 * descendants that were destroyed with it; failure carries the wire refusal
 * verbatim, and in that case nothing was deleted.
 */
export type DestroySessionOutcome =
  | { ok: true; sessionId: SessionId; descendants: SessionId[] }
  | { ok: false; error: RpcError }

/** Why one scanned session was left alone. */
export type ReapSkipReason =
  /** A turn is running: live work always wins over the idle clock. */
  | 'running'
  /** The Agent holds queued work (a queued next turn or pending steering). */
  | 'queued'
  /** Its last durable event is newer than the threshold. */
  | 'fresh'
  /** The stored log holds no event at all, so there is no idle clock to read. */
  | 'no-events'
  /** The log could not be read this pass; a read failure never justifies a delete. */
  | 'unreadable'

/** What one pass did, for the log line and for tests. */
export interface ReapPassReport {
  /** Subagent headers the pass examined. */
  scanned: number
  /** Sessions this pass destroyed through the shared routine. */
  reaped: SessionId[]
  /** Sessions left alone, with the reason. */
  skipped: { sessionId: SessionId; reason: ReapSkipReason }[]
  /** Sessions the destroy routine refused, with its message. */
  refused: { sessionId: SessionId; reason: string }[]
}

/** Collaborators the pass needs, injected so tests do not wait six hours. */
export interface ReapPassOptions {
  /** The shared destroy routine (`session.destroy`). Never a direct log delete. */
  destroy(sessionId: SessionId): Promise<DestroySessionOutcome>
  /** This pass's wall clock, in epoch milliseconds. */
  now(): number
  /** Idle threshold in milliseconds. */
  idleMs: number
  /** Records refusals and reap decisions; `ctx.logger` in production. */
  logger: { info(message: string): void; warn(message: string): void }
}

/**
 * The last event time of a session's durable log.
 *
 * An attached session's live log is the same log and reaches one write-behind
 * flush past the stored bytes, so its in-memory tail is at least as fresh as
 * what is on disk — reading it is both cheaper and the conservative direction
 * (a fresher reading only ever postpones a reap). A cold session is read
 * through the persistence seam, which is the authority: `origin`, lifetime and
 * idleness all come from stored state, never from when this process started.
 * @param ctx - Host context carrying the optional persistence backend.
 * @param header - the stored header of the session being judged.
 * @param live - the attached Session, when one exists.
 * @returns the last stored event's time, or `undefined` when the log has none.
 */
async function lastDurableEventTime(
  ctx: Context,
  header: SessionHeader,
  live: Session | undefined,
): Promise<number | undefined> {
  if (live !== undefined && live.events.length > 0) return live.events.at(-1)?.time
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return undefined
  const { events } = await persistence.readFrom(header.id, 0)
  return events.at(-1)?.time
}

/**
 * Whether one stored header names a spawned subagent session.
 *
 * `origin` is written once, durably, by the delegating spawn path and is absent
 * from every header a person's own conversation has: `session.create` never
 * sets it, a persistent inbox row is a client-chosen id on that path, and a fork
 * is its own top-level conversation. So this predicate cannot be satisfied by
 * anything except a session some Agent spawned.
 * @param header - the durable session header.
 * @returns whether this is a subagent session.
 */
export function isSubagentSession(header: Pick<SessionHeader, 'origin'>): boolean {
  return header.origin === 'subagent'
}

/**
 * One reaper pass over the durable session store.
 *
 * Reads every stored header, keeps the subagent ones, drops those with live
 * work, compares the remaining last-event time against the threshold and hands
 * the survivors to the shared destroy routine one at a time. Read-only except
 * through that routine.
 * @param ctx - Host context carrying the persistence backend and Agent registry.
 * @param options - the destroy routine, the clock and the threshold.
 * @returns the pass report (also logged, per decision).
 */
export async function reapIdleSubagentSessions(
  ctx: Context,
  options: ReapPassOptions,
): Promise<ReapPassReport> {
  const report: ReapPassReport = { scanned: 0, reaped: [], skipped: [], refused: [] }
  const persistence = ctx.get('sessionPersistence')
  if (persistence === undefined) return report
  if (!persistence.supportsDestroy) {
    // The destroy routine refuses for the same reason; one line per boot beats
    // one line per stored session.
    options.logger.warn(
      'subagent idle reaper: the composed persistence backend cannot delete stored sessions; nothing will be reaped',
    )
    return report
  }
  const now = options.now()
  for (const header of await persistence.list()) {
    if (!isSubagentSession(header)) continue
    report.scanned++
    const live = ctx.sessions.get(header.id)
    const agent = ctx.agents.get(header.id)
    // Rule 2: live work outranks the idle clock, whatever the log age says.
    if (agent?.status === 'running') {
      report.skipped.push({ sessionId: header.id, reason: 'running' })
      continue
    }
    if (agent !== undefined && agent.inbox.hasPending) {
      report.skipped.push({ sessionId: header.id, reason: 'queued' })
      continue
    }
    let last: number | undefined
    try {
      last = await lastDurableEventTime(ctx, header, live)
    } catch (error: unknown) {
      // An unreadable log is not evidence of idleness, and this pass has no
      // business acting on a guess.
      options.logger.warn(
        `subagent idle reaper: could not read the stored log of "${header.id}"; leaving it alone: ${String(error)}`,
      )
      report.skipped.push({ sessionId: header.id, reason: 'unreadable' })
      continue
    }
    if (last === undefined) {
      report.skipped.push({ sessionId: header.id, reason: 'no-events' })
      continue
    }
    // "At least the threshold" is idle: `>=` here means exactly six hours old
    // already qualifies.
    if (now - last < options.idleMs) {
      report.skipped.push({ sessionId: header.id, reason: 'fresh' })
      continue
    }
    // Rule 3: the shared routine owns everything destructive, including the
    // commit point. Rule "never force it": a refusal is reported and retried on
    // the next pass, never escalated into deleting the log.
    const outcome = await options.destroy(header.id)
    if (outcome.ok) {
      report.reaped.push(header.id)
      const idleMs = now - last
      options.logger.info(
        `subagent idle reaper: destroyed "${header.id}" after ${String(idleMs)} ms idle`
        + (outcome.descendants.length === 0
          ? ''
          : ` (with ${String(outcome.descendants.length)} descendant(s): ${outcome.descendants.join(', ')})`),
      )
    } else {
      report.refused.push({ sessionId: header.id, reason: outcome.error.message })
      options.logger.warn(
        `subagent idle reaper: destroy refused for "${header.id}"; leaving it alone and retrying next pass: ${outcome.error.message}`,
      )
    }
  }
  return report
}

/**
 * Arm the reaper: one pass now, then one per scan interval for this context's
 * lifetime.
 *
 * The boot pass is deliberate — idleness is measured from the stored log, so a
 * restart changes no one's clock and a stale backlog should clear immediately
 * rather than after another full interval. Passes never overlap: a slow pass
 * (a large log, a cancelling turn) makes the next tick a no-op rather than
 * running two destroys over the same session.
 * @param ctx - Host context; its timer and logger drive the loop.
 * @param options - validated `subagentIdleReap` config.
 * @param destroy - the shared `session.destroy` routine.
 */
export function startSubagentIdleReaper(
  ctx: Context,
  options: SubagentIdleReapConfig,
  destroy: (sessionId: SessionId) => Promise<DestroySessionOutcome>,
): void {
  let inFlight = false
  const pass = async (): Promise<void> => {
    if (inFlight) return
    inFlight = true
    try {
      await reapIdleSubagentSessions(ctx, {
        destroy,
        now: () => Date.now(),
        idleMs: options.idleMs,
        logger: ctx.logger,
      })
    } catch (error: unknown) {
      // A pass that throws must not kill the loop: the next interval retries.
      ctx.logger.warn(`subagent idle reaper: pass failed: ${String(error)}`)
    } finally {
      inFlight = false
    }
  }
  ctx.effect(() => {
    // A raw timer rather than `ctx.interval()` on purpose: the host's timer
    // plugin is an optional composition row, and housekeeping must not turn a
    // deployment without it into a boot failure. The effect disposer clears the
    // interval with the context, and `unref` keeps the reaper from being the
    // one handle that holds a shutting-down process open.
    const timer = setInterval(() => { void pass() }, options.scanIntervalMs)
    timer.unref()
    return () => { clearInterval(timer) }
  }, 'api-proxy: subagent idle reaper')
  // Boot pass: idleness is measured from the stored log, so a restart changes
  // nobody's clock and a stale backlog should clear now rather than in an hour.
  void pass()
}
