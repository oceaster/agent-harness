/**
 * InboxPanel: the sidebar's browsing region. One row per agent the server
 * returned, in the server's order, with a three-dot menu whose only action is
 * Clear. Wide renders the section header plus rows; the rail renders one glyph
 * per agent so the collapsed column still has a body.
 *
 * Presentation only: every value arrives through the composed props shares
 * (runtime share, injected face, locale seat). No ctx, no fetch, no agent list
 * of its own — the rows ARE the payload, so the panel cannot invent an agent or
 * hide one the person owns.
 *
 * Three non-list states, deliberately distinct screens rather than a blank div:
 * a read in flight, a profile this deployment refuses (`refused`: no retry —
 * retrying cannot help), and a read that failed (retry).
 */
import { useState } from 'react'
import clsx from 'clsx'
import {
  IconEllipsisOutline16, IconRefreshOutline16, IconTrashOutline16, IconPanelLeftOutline16, Menu, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InboxAgentRow } from './inbox-api.ts'
import type { InboxNoticeCode } from './inbox-controller.ts'
import type { InboxPanelProps } from './slots.ts'
import { ConfirmClearDialog } from './ConfirmClearDialog.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { PresenceDot } from './PresenceDot.tsx'
import { presenceOf, type InboxPresence } from './presence.ts'
import css from './InboxPanel.module.css'

/** The locale seat of this namespace, passed to the pure helpers below. */
type Translate = InboxPanelProps['t']

/** Time unit buckets for the row's state line. */
type AgeUnit = 'now' | 'min' | 'hour' | 'day'

/**
 * Bucket an epoch-seconds timestamp against now.
 * @param at - epoch seconds of the last message.
 * @param now - epoch seconds now.
 * @returns the unit and, for every unit but `now`, the count.
 */
function age(at: number, now: number): { unit: AgeUnit; n: number } {
  const seconds = Math.max(0, now - at)
  if (seconds < 60) return { unit: 'now', n: 0 }
  if (seconds < 3600) return { unit: 'min', n: Math.floor(seconds / 60) }
  if (seconds < 86_400) return { unit: 'hour', n: Math.floor(seconds / 3600) }
  return { unit: 'day', n: Math.floor(seconds / 86_400) }
}

/** Localized relative time ("now" / "5m ago" in en, "刚刚" / "5 分钟前" in zh). */
function ageLabel(at: number, now: number, t: Translate): string {
  const { unit, n } = age(at, now)
  return unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
}

/**
 * How many delegations the row's payload says are waiting for a worker slot.
 * Absent means none, and a value that is not a whole non-negative count reads
 * as none too: the panel renders server numbers, it never repairs them.
 * @param row - the row as the server described it.
 * @returns the queued count, zero when the payload carries none.
 */
function queuedOf(row: InboxAgentRow): number {
  const queued = row.queuedWorkers
  return typeof queued === 'number' && Number.isSafeInteger(queued) && queued > 0 ? queued : 0
}

/**
 * The working verb one row says. Each agent works its own way, so the row does
 * not report one generic sentence for every agent.
 */
type AgentVerb = 'working' | 'chatting' | 'thinking'

/**
 * The verb each agent shows while it works, keyed by the agent id the server
 * sends on the row. That id is also the session's agent preset, so the chat's
 * running-turn status says the same word for the same agent.
 *
 * Deliberately local to this package, for the reason the household brand mark
 * in `ChannelPlaceholder.tsx` is: ui-inbox and ui-conversation are independent
 * client packages that must not import each other's internals, and both need
 * this map. Two four-entry copies are cheaper than a new shared package both
 * would depend on — keep them in step by hand. An id the map does not know
 * (a deployment's own preset, a row with no preset at all) says the generic
 * `working` verb rather than nothing.
 */
const AGENT_VERBS: Record<string, AgentVerb> = {
  delta: 'working',
  darwin: 'working',
  diana: 'chatting',
  dexter: 'thinking',
}

/**
 * The verb for one agent id, with the generic fallback the map documents.
 * @param agent - the row's agent id as the server sent it.
 * @returns the verb this row says.
 */
function agentVerb(agent: string): AgentVerb {
  return AGENT_VERBS[agent] ?? 'working'
}

/**
 * The working copy, count included. The state line and the dot's accessible
 * label both come from here, so the row never reports two different verbs for
 * the same work.
 *
 * One number while nothing waits (`Working... (3)`); a working/total pair once
 * the server reports a queue behind them (`Working... (3/4)` — three working,
 * four in flight). The denominator is working + queued, not a slot limit, and
 * it is only shown when there is a queue: the count never reads `(0)` and never
 * carries a bare `/`, so zero working workers keep the bare verb.
 * @param active - running conversations below this row, at any depth.
 * @param queued - delegations the server reports waiting for a worker slot.
 * @param agent - the row's agent id, which picks the verb.
 * @param t - the locale seat.
 * @returns the working copy.
 */
function workingLabel(active: number, queued: number, agent: string, t: Translate): string {
  const verb = agentVerb(agent)
  if (active <= 0) return t(`verb.${verb}.line`)
  return queued > 0
    ? t(`verb.${verb}.pair`, { working: active, total: active + queued })
    : t(`verb.${verb}.count`, { n: active })
}

/**
 * The dot's accessible label and hover title for one row. A working row repeats
 * the state line exactly once a count is shown; with no subagent the label is
 * the bare verb, so the dot never claims a count it does not have.
 * @param status - the status the dot shows.
 * @param active - running conversations below this row, at any depth.
 * @param queued - delegations the server reports waiting for a worker slot.
 * @param agent - the row's agent id, which picks the verb.
 * @param t - the locale seat.
 * @returns the label text.
 */
function presenceLabel(
  status: InboxPresence, active: number, queued: number, agent: string, t: Translate,
): string {
  if (status !== 'running') return t(`presence.${status}`)
  return active > 0 ? workingLabel(active, queued, agent, t) : t(`verb.${agentVerb(agent)}.dot`)
}

/**
 * The row's one-line state: working, last activity, or the neutral fresh line.
 * @param row - the row as the server described it.
 * @param now - epoch seconds now.
 * @param t - the locale seat.
 * @param active - running conversations below this row, at any depth.
 * @returns the state line.
 */
function stateLine(row: InboxAgentRow, now: number, t: Translate, active: number): string {
  if (row.enabled === false) return t(row.disabled === true ? 'row.disabled' : 'presence.offline')
  if (row.running || active > 0) return workingLabel(active, queuedOf(row), row.agent, t)
  if (row.presence === 'error') return t('presence.error')
  if (row.presence === 'unread') return t('presence.unread')
  if (!row.hasConversation) return t('row.fresh')
  if (row.blank || row.lastActivityAt === null) return t('row.blank')
  return ageLabel(row.lastActivityAt, now, t)
}

/**
 * The row's avatar monogram: the first character of the name the server sent.
 * Deliberately derived, never configured — a per-agent colour table would be a
 * hardcoded roster in disguise.
 * @param name - display name from the payload.
 * @returns the monogram text.
 */
function monogram(name: string): string {
  const [first] = Array.from(name.trim())
  return first === undefined ? '?' : first.toUpperCase()
}

/**
 * Copy for one row's last failed action.
 * @param notice - the recorded code.
 * @param t - the locale seat.
 * @returns the sentence to show.
 */
function noticeText(notice: InboxNoticeCode, t: Translate): string {
  switch (notice) {
    case 'clear-refused': return t('notice.clear-refused')
    case 'session-not-listed': return t('notice.session-not-listed')
    default: return t(`error.${notice}`)
  }
}

/**
 * Render the inbox region.
 * @param props - composed slot props (runtime share + injected face + locale seat).
 * @returns the inbox element tree.
 */
export function InboxPanel({
  wide, expandSidebar, collapseSidebar, useInbox, useChannels, load, open, clear,
  openChannel, clearChannel, t,
}: InboxPanelProps) {
  const channelState = useChannels(snapshot => snapshot)
  const state = useInbox(snapshot => snapshot)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [confirmFor, setConfirmFor] = useState<string | null>(null)
  const [confirmChannel, setConfirmChannel] = useState<string | null>(null)
  const confirmedChannel = channelState.rows.find(channel => channel.id === confirmChannel)
  // One clock read per render: every row's age is measured against the same now.
  const now = Date.now() / 1000
  const confirmed = confirmFor === null ? undefined : state.rows.find(row => row.agent === confirmFor)

  if (!wide) {
    return (
      <div className={css.rail} data-testid="ui-inbox-rail" aria-label={t('panel.rail.label')}>
        {state.rows.map((row) => {
          const busy = state.busy.includes(row.agent)
          const active = state.activeSubagents[row.agent] ?? 0
          const status = presenceOf(row, active)
          return (
            <button
              key={row.agent}
              type="button"
              className={clsx(css.railGlyph, state.openAgent === row.agent && css.railGlyphActive)}
              data-testid={`ui-inbox-rail-${row.agent}`}
              aria-label={t('row.open', { name: row.name })}
              aria-busy={busy}
              disabled={row.enabled === false}
              onClick={() => {
                expandSidebar()
                open(row.agent)
              }}
            >
              <AgentAvatar agents={[row.agent]} label={monogram(row.name)} />
              <PresenceDot status={status} label={presenceLabel(status, active, queuedOf(row), row.agent, t)} />
            </button>
          )
        })}
      </div>
    )
  }

  return (
    <div className={css.panel} data-testid="ui-inbox-panel">
      <div className={css.header}>
        <button type="button" className={css.refresh} aria-label={t('panel.collapse')} onClick={collapseSidebar}><IconPanelLeftOutline16 size={16} /></button>
        <span className={css.title}>{t('section.agents')}</span>
        <button
          type="button"
          className={css.refresh}
          aria-label={t('panel.refresh')}
          title={t('panel.refresh')}
          data-testid="ui-inbox-refresh"
          onClick={() => { load() }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>

      {/* A read that failed while rows from an earlier read survive: the rows
          stay usable and the failure is stated above them, not swallowed. */}
      {state.loadError !== null && state.rows.length > 0 && (
        <div className={css.banner} role="status" data-testid="ui-inbox-banner">
          <span>{t(`error.${state.loadError}`)}</span>
          <button type="button" className={css.bannerAction} onClick={() => { load() }}>{t('state.retry')}</button>
        </div>
      )}

      {state.status === 'loading' && state.rows.length === 0 && (
        <p className={css.phase} data-testid="ui-inbox-loading">{t('state.loading')}</p>
      )}

      {/* A profile this deployment refuses (the guest profile answers 403 before
          any inbox route exists): say so plainly, with no retry — retrying
          cannot change it. Distinct from both the empty list and a failure. */}
      {state.status === 'refused' && (
        <div className={css.phaseBlock} data-testid="ui-inbox-refused">
          <p className={css.phaseTitle}>{t('state.refused.title')}</p>
          <p className={css.phaseBody}>{t('state.refused.body')}</p>
        </div>
      )}

      {state.status === 'error' && state.rows.length === 0 && (
        <div className={css.phaseBlock} data-testid="ui-inbox-error">
          <p className={css.phaseTitle}>{t('state.error')}</p>
          {/* A load failure with no code still has to say something. */}
          <p className={css.phaseBody}>{t(`error.${state.loadError ?? 'unexpected'}`)}</p>
          <button type="button" className={css.retry} data-testid="ui-inbox-retry" onClick={() => { load() }}>
            {t('state.retry')}
          </button>
        </div>
      )}

      {state.status === 'ready' && state.rows.length === 0 && (
        <div className={css.phaseBlock} data-testid="ui-inbox-empty">
          <p className={css.phaseTitle}>{t('state.empty.title')}</p>
          <p className={css.phaseBody}>{t('state.empty.body')}</p>
        </div>
      )}

      {state.rows.length > 0 && (
        <ul className={css.list}>
          {state.rows.map((row) => {
            const busy = state.busy.includes(row.agent)
            const notice = state.notices[row.agent]
            const active = state.activeSubagents[row.agent] ?? 0
            const status = presenceOf(row, active)
            return (
              <li
                key={row.agent}
                className={clsx(css.row, state.openAgent === row.agent && channelState.selected === null && css.rowActive)}
                data-testid={`ui-inbox-row-${row.agent}`}
              >
                <div className={css.rowLine}>
                  <button
                    type="button"
                    className={css.rowButton}
                    data-testid={`ui-inbox-open-${row.agent}`}
                    aria-label={t('row.open', { name: row.name })}
                    aria-current={state.openAgent === row.agent && channelState.selected === null ? 'true' : undefined}
                    aria-busy={busy}
                    disabled={row.enabled === false}
                    onClick={() => { open(row.agent) }}
                  >
                    <span className={css.avatarStatus}>
                      <AgentAvatar agents={[row.agent]} label={monogram(row.name)} />
                      <PresenceDot status={status} label={presenceLabel(status, active, queuedOf(row), row.agent, t)} />
                    </span>
                    <span className={css.rowText}>
                      <span className={css.name}>{row.name}</span>
                      <span className={css.state} data-testid={`ui-inbox-state-${row.agent}`}>
                        {busy && <StateDot state="ongoing" size={8} className={css.stateDot} />}
                        {busy ? t('row.opening') : stateLine(row, now, t, active)}
                      </span>
                    </span>
                  </button>
                  <Menu
                    open={menuFor === row.agent}
                    onClose={() => { setMenuFor(null) }}
                    items={row.enabled === false ? [] : [{ id: 'clear', label: t('row.clear'), icon: <IconTrashOutline16 size={14} />, danger: true }]}
                    onSelect={(id) => {
                      setMenuFor(null)
                      if (id !== 'clear') return
                      setConfirmFor(row.agent)
                    }}
                    portal
                    anchor={(
                      <button
                        type="button"
                        className={css.menuButton}
                        aria-label={t('row.menu', { name: row.name })}
                        aria-haspopup="menu"
                        disabled={row.enabled === false}
                        aria-expanded={menuFor === row.agent}
                        data-testid={`ui-inbox-menu-${row.agent}`}
                        onClick={() => { setMenuFor(current => (current === row.agent ? null : row.agent)) }}
                      >
                        <IconEllipsisOutline16 size={14} />
                      </button>
                    )}
                  />
                </div>
                {notice !== undefined && (
                  <p className={css.notice} role="status" data-testid={`ui-inbox-notice-${row.agent}`}>
                    {noticeText(notice, t)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <section className={css.channels} aria-label={t('channel.section')}>
        <h3 className={css.channelTitle}>{t('channel.section')}</h3>
        <ul className={css.list}>
          {channelState.rows.map((channel) => {
            const online = channel.agents.every(agent => state.rows.some(row => row.agent === agent && row.enabled !== false))
            return <li key={channel.id}
              className={clsx(css.row, channelState.selected?.id === channel.id && css.rowActive)}
              data-testid={'agent-channel-row-' + channel.id}>
              <div className={css.rowLine}>
                <button type="button" className={css.rowButton} data-testid={'agent-channel-open-' + channel.id}
                  aria-current={channelState.selected?.id === channel.id ? 'true' : undefined}
                  onClick={() => { openChannel(channel.id) }}>
                  <span className={css.avatarStatus}>
                    <AgentAvatar agents={channel.agents} label="↔" />
                    <PresenceDot status={online ? 'online' : 'offline'}
                      label={t(online ? 'presence.online' : 'presence.offline')} />
                  </span>
                  <span className={css.rowText}>
                    <span className={css.name}>{channel.name}</span>
                    <span className={css.state}>{t('channel.readOnly')}</span>
                  </span>
                </button>
                <Menu open={menuFor === 'channel:' + channel.id} onClose={() => { setMenuFor(null) }}
                  items={[{ id: 'clear', label: t('row.clear'), icon: <IconTrashOutline16 size={14} />, danger: true }]}
                  onSelect={() => { setMenuFor(null); setConfirmChannel(channel.id) }} portal
                  anchor={<button type="button" className={css.menuButton}
                    aria-label={t('row.menu', { name: channel.name })} aria-haspopup="menu"
                    aria-expanded={menuFor === 'channel:' + channel.id} data-testid={'agent-channel-menu-' + channel.id}
                    onClick={() => { setMenuFor(current => current === 'channel:' + channel.id ? null : 'channel:' + channel.id) }}>
                    <IconEllipsisOutline16 size={14} />
                  </button>} />
              </div>
            </li> })}
        </ul>
        {channelState.rows.length === 0 && channelState.error === null && <p className={css.phase}>{t('channel.none')}</p>}
        {channelState.error !== null && channelState.selected === null && <p role="alert">{channelState.error}</p>}
      </section>
      <ConfirmClearDialog open={confirmedChannel !== undefined} agentName={confirmedChannel?.name ?? ''} channel t={t}
        onCancel={() => { setConfirmChannel(null) }}
        onConfirm={() => {
          const target = confirmChannel
          setConfirmChannel(null)
          if (target !== null) clearChannel(target)
        }} />
      <ConfirmClearDialog
        open={confirmed !== undefined}
        agentName={confirmed?.name ?? ''}
        t={t}
        onCancel={() => { setConfirmFor(null) }}
        onConfirm={() => {
          const target = confirmFor
          setConfirmFor(null)
          if (target !== null) clear(target)
        }}
      />
    </div>
  )
}
