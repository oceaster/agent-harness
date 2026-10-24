/**
 * EpsilonPanel: the OTHER interface of the one shell — the sidebar of Delta's
 * sub-agents.
 *
 * Owen, 2026-10-23: "epsilon btn takes us to the same interface, but instead of
 * seeing inbox & agent channels in the sidebar... I see the 'Delta sub-agents'
 * list." So this panel is the inbox's sibling, not its variant: same shell, same
 * conversation column, same row component, DIFFERENT sidebar body.
 *
 * WHAT IS THE SAME, AND WHY IT IS THE SAME CODE: every row here is the markup and
 * the CSS classes of an inbox agent row — `li` + row line + one button + avatar
 * and presence dot + a name and one state line (see InboxPanel.module.css, which
 * both panels import). Owen's structural rule is that the two interfaces must be
 * "SAME SAME, DIFFERENT, BUT SAME", and the only way to keep that true after the
 * next styling change is for both to wear the same classes rather than for this
 * file to be a copy. What differs is what the rows MEAN: a worker is named by its
 * position in Delta's catalog ("Epsilon 3", short "E3"), its second line is the
 * durable task label the harness recorded, and there is no menu: you cannot clear
 * a worker from here.
 *
 * WHERE THE ROWS COME FROM: the controller's roster, which is Delta's own
 * conversation's catalog (see inbox-controller.ts) — never the conversation the
 * pane happens to show. This panel therefore lists the household's workers while
 * a worker transcript is on screen, and it does not go empty when you use it.
 *
 * Presentation only: every value arrives through the composed slot props. No
 * fetch, no ctx, no roster of its own.
 */
import clsx from 'clsx'
import { IconRefreshOutline16, IconPanelLeftOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InboxNoticeCode, InboxWorkerRow } from './inbox-controller.ts'
import type { InboxPanelProps } from './slots.ts'
import { AgentAvatar } from './AgentAvatar.tsx'
import { PresenceDot } from './PresenceDot.tsx'
import css from './InboxPanel.module.css'

/** The locale seat of this namespace, passed to the pure helpers below. */
type Translate = InboxPanelProps['t']

/**
 * The household's name for one sub-agent: "Epsilon 3" once, on its own row.
 *
 * Owen's rule (2026-10-23): a sub-agent is named once in long form and is "E3"
 * afterwards. The short form is the avatar's monogram here, and nothing else on
 * this surface prints a worker's name a second time — the row's second line is
 * the durable task label the harness recorded, not the name again.
 * @param index - the worker's 1-based position in Delta's catalog.
 * @param t - the locale seat.
 * @returns the long form.
 */
function workerName(index: number, t: Translate): string {
  return t('worker.name', { n: index })
}

/**
 * Copy for one refused worker.
 * @param notice - the recorded code.
 * @param t - the locale seat.
 * @returns the sentence to show.
 */
function workerNoticeText(notice: InboxNoticeCode, t: Translate): string {
  switch (notice) {
    case 'worker-unavailable': return t('worker.unavailable')
    case 'clear-refused': return t('notice.clear-refused')
    case 'session-not-listed': return t('notice.session-not-listed')
    default: return t(`error.${notice}`)
  }
}

/**
 * Render the epsilon sidebar.
 * @param props - composed slot props (runtime share + injected face + locale seat).
 * @returns the sub-agent list element tree.
 */
export function EpsilonPanel({
  wide, portrait = false, expandSidebar, collapseSidebar, collapseOnSelection = () => {},
  useInbox, openWorker, loadWorkers, t,
}: InboxPanelProps) {
  const state = useInbox(snapshot => snapshot)

  if (!wide) {
    // Rail: one glyph per sub-agent, sharing the inbox rail's own dimensions and
    // its selected border, so a folded sidebar of either interface reads as the
    // same column. A glyph carries the worker's stable short name as its
    // accessible label and nothing else: the rail overlays the chat in portrait,
    // so it must not paint task lines or statuses there.
    return (
      <div className={css.rail} data-testid="ui-epsilon-rail" aria-label={t('workers.rail')}>
        {state.workers.map(worker => (
          <button
            key={worker.id}
            type="button"
            className={clsx(css.railGlyph, worker.id === state.openWorkerId && css.railGlyphActive)}
            data-testid={`ui-epsilon-glyph-${worker.id}`}
            aria-label={t('worker.open', { name: workerName(worker.index, t) })}
            aria-current={worker.id === state.openWorkerId ? 'true' : undefined}
            disabled={worker.damaged}
            onClick={() => {
              if (!portrait) expandSidebar()
              collapseOnSelection()
              openWorker(worker.id)
            }}
          >
            <AgentAvatar agents={[]} label={t('worker.short', { n: worker.index })} />
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className={css.panel} data-testid="ui-epsilon-panel">
      <div className={css.header}>
        <button type="button" className={css.refresh} aria-label={t('panel.collapse')} onClick={collapseSidebar}>
          <IconPanelLeftOutline16 size={16} />
        </button>
        <span className={css.title}>{t('workers.section')}</span>
        <button
          type="button"
          className={css.refresh}
          aria-label={t('workers.refresh')}
          title={t('workers.refresh')}
          data-testid="ui-epsilon-refresh"
          onClick={() => { loadWorkers() }}
        >
          <IconRefreshOutline16 size={14} />
        </button>
      </div>

      {/* A read that failed while rows from an earlier read survive: the rows
          stay usable and the failure is stated above them, not swallowed. */}
      {state.workersState === 'error' && state.workers.length > 0 && (
        <div className={css.banner} role="status" data-testid="ui-epsilon-banner">
          <span>{t('workers.error')}</span>
          <button type="button" className={css.bannerAction} onClick={() => { loadWorkers() }}>{t('state.retry')}</button>
        </div>
      )}

      {(state.workersState === 'loading' || state.workersState === 'idle') && state.workers.length === 0 && (
        <p className={css.phase} data-testid="ui-epsilon-loading">{t('state.loading')}</p>
      )}

      {state.workersState === 'error' && state.workers.length === 0 && (
        <div className={css.phaseBlock} data-testid="ui-epsilon-error">
          <p className={css.phaseTitle}>{t('workers.error')}</p>
          <button type="button" className={css.retry} data-testid="ui-epsilon-retry" onClick={() => { loadWorkers() }}>
            {t('state.retry')}
          </button>
        </div>
      )}

      {/* Delta has no workers right now. Said plainly rather than painted as an
          empty column, because an empty column reads as broken. */}
      {state.workersState === 'ready' && state.workers.length === 0 && (
        <div className={css.phaseBlock} data-testid="ui-epsilon-empty">
          <p className={css.phaseTitle}>{t('workers.none.title')}</p>
          <p className={css.phaseBody}>{t('workers.none.body')}</p>
        </div>
      )}

      {state.workers.length > 0 && (
        <ul className={css.list}>
          {state.workers.map((worker: InboxWorkerRow) => {
            const name = workerName(worker.index, t)
            const open = worker.id === state.openWorkerId
            const notice = state.workerNotice?.id === worker.id ? state.workerNotice.code : undefined
            return (
              <li
                key={worker.id}
                className={clsx(css.row, open && css.rowActive)}
                data-testid={`ui-epsilon-row-${worker.id}`}
              >
                <div className={css.rowLine}>
                  <button
                    type="button"
                    className={css.rowButton}
                    data-testid={`ui-epsilon-open-${worker.id}`}
                    aria-label={t('worker.open', { name })}
                    aria-current={open ? 'true' : undefined}
                    disabled={worker.damaged}
                    onClick={() => {
                      // The selection event, not a render effect: in portrait the
                      // worker's transcript gets the screen back.
                      collapseOnSelection()
                      openWorker(worker.id)
                    }}
                  >
                    <span className={css.avatarStatus}>
                      <AgentAvatar agents={[]} label={t('worker.short', { n: worker.index })} />
                      <PresenceDot
                        status={worker.running ? 'running' : 'offline'}
                        label={t(worker.running ? 'presence.running' : 'presence.offline')}
                      />
                    </span>
                    <span className={css.rowText}>
                      <span className={css.name}>{name}</span>
                      <span className={css.state} data-testid={`ui-epsilon-state-${worker.id}`}>
                        {worker.damaged ? t('worker.damaged') : worker.label ?? t('worker.noTask')}
                      </span>
                    </span>
                  </button>
                </div>
                {notice !== undefined && (
                  <p className={css.notice} role="status" data-testid={`ui-epsilon-notice-${worker.id}`}>
                    {workerNoticeText(notice, t)}
                  </p>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
