/**
 * Learn More: the guides for the agents this person may use, as a compressed
 * reference sheet. It fills the settings modal's content column, scrolls with
 * it, and reads as a sheet rather than a card per agent: one dense block per
 * agent — its name, its one-line summary, then each section's heading beside its
 * prose.
 *
 * Presentation only: every value arrives through the composed props shares
 * (runtime share, injected face, locale seat). No ctx, no fetch, and no agent,
 * section id or guide prose of its own — the payload IS the content, so the
 * section cannot invent an agent, drop a section the server started sending, or
 * reorder what the server ordered.
 *
 * Four states, deliberately distinct screens rather than a blank div: a read in
 * flight; a profile this deployment refuses (`refused`: no retry, retrying
 * cannot help); a read that failed (retry, and the server's own sentence when it
 * sent one); and a person whose roster resolves to no agent, which is a policy
 * answer and not a failure.
 */
import { useEffect } from 'react'
import type { LearnAgent, LearnFailureCode } from './learn-api.ts'
import type { LearnSectionProps } from './slots.ts'
import css from './LearnSection.module.css'

/** The locale seat of this namespace, passed to the pure helpers below. */
type Translate = LearnSectionProps['t']

/**
 * Split a guide body into paragraphs. The server sends plain text with a blank
 * line between paragraphs, so that is the only rule applied — no markdown, no
 * HTML, no reflow of the words themselves.
 * @param body - one section's prose, verbatim.
 * @returns the non-empty paragraphs, in order.
 */
export function paragraphs(body: string): readonly string[] {
  return body.split(/\n{2,}/).map(part => part.trim()).filter(part => part.length > 0)
}

/**
 * The fallback sentence for a failure that carried no server detail.
 * @param code - the failure code.
 * @param t - the locale seat.
 * @returns the localized reason for that code.
 */
function reasonText(code: LearnFailureCode, t: Translate): string {
  return t(`error.${code}`)
}

/**
 * One agent's block: name, summary, then its sections in the server's order.
 * @param props - the guide and the locale seat.
 * @returns the agent's element tree.
 */
function AgentGuide({ agent, t }: { agent: LearnAgent; t: Translate }) {
  return (
    <article className={css.agent} data-testid={`ui-learn-agent-${agent.agent}`}>
      <div className={css.agentHead}>
        <h3 className={css.name}>{agent.name}</h3>
        {!agent.enabled && <span className={css.badge}>{t('agent.disabled')}</span>}
      </div>
      <p className={css.summary}>{agent.summary}</p>
      <dl className={css.sections}>
        {agent.sections.map(section => (
          <div
            key={section.id}
            className={css.section}
            data-testid={`ui-learn-${agent.agent}-${section.id}`}
          >
            <dt className={css.sectionTitle}>{section.title}</dt>
            <dd className={css.sectionBody}>
              {paragraphs(section.body).map((text, index) => (
                <p key={`${section.id}-${String(index)}`}>{text}</p>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </article>
  )
}

/**
 * Render the Learn More section.
 * @param props - composed slot props (runtime share + injected face + locale seat).
 * @returns the section element tree.
 */
export function LearnSection({ useLearn, load, t }: LearnSectionProps) {
  const state = useLearn(snapshot => snapshot)
  // The read starts here rather than at plugin load, so a person who never
  // opens this tab costs no request. The controller drops a call that arrives
  // while one is in flight, which is what keeps this effect cheap on re-render.
  const beforeFirstAnswer = state.status === 'loading' && state.failure === null
  useEffect(() => {
    if (beforeFirstAnswer) load()
  }, [beforeFirstAnswer, load])

  const failure = state.failure
  const detail = failure === null ? null : failure.detail

  if (state.status === 'loading') {
    return <p className={css.phase} data-testid="ui-learn-loading">{t('state.loading')}</p>
  }

  // A profile this deployment refuses answers 403 before the learn route runs.
  // Distinct from both an empty roster and a failed read, and there is no retry
  // because retrying cannot change a policy answer.
  if (state.status === 'refused') {
    return (
      <div className={css.phaseBlock} data-testid="ui-learn-refused">
        <p className={css.phaseTitle}>{t('state.refused.title')}</p>
        <p className={css.phaseBody}>{t('state.refused.body')}</p>
        {detail !== null && (
          <p className={css.detail} data-testid="ui-learn-refused-detail">
            <span className={css.detailLabel}>{t('state.detail')}</span>{' '}{detail}
          </p>
        )}
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className={css.phaseBlock} data-testid="ui-learn-error">
        <p className={css.phaseTitle} role="alert">{t('state.error')}</p>
        {/* The server's own sentence when it wrote one — it names the agent
            whose guide is missing, or says the harness is restarting — and the
            code's copy only when there is none. Never the other way round. */}
        {detail !== null
          ? (
            <p className={css.detail} data-testid="ui-learn-detail">
              <span className={css.detailLabel}>{t('state.detail')}</span>{' '}{detail}
            </p>
          )
          : (
            <p className={css.phaseBody} data-testid="ui-learn-reason">
              {reasonText(failure === null ? 'unexpected' : failure.code, t)}
            </p>
          )}
        <button type="button" className={css.retry} data-testid="ui-learn-retry" onClick={() => { load() }}>
          {t('state.retry')}
        </button>
      </div>
    )
  }

  // Ready. An empty roster is the policy answer "this profile may open no
  // agent": its own message, never an error and never a blank panel.
  if (state.agents.length === 0) {
    return (
      <div className={css.phaseBlock} data-testid="ui-learn-empty">
        <p className={css.phaseTitle}>{t('state.empty.title')}</p>
        <p className={css.phaseBody}>{t('state.empty.body')}</p>
      </div>
    )
  }

  return (
    <div className={css.sheet} data-testid="ui-learn-sheet">
      <header className={css.head}>
        <p className={css.intro}>{t('intro')}</p>
        {state.person !== null && (
          <p className={css.person} data-testid="ui-learn-person">
            {t('person', { name: state.person.name })}
          </p>
        )}
      </header>
      <div className={css.agents}>
        {state.agents.map(agent => <AgentGuide key={agent.agent} agent={agent} t={t} />)}
      </div>
    </div>
  )
}
