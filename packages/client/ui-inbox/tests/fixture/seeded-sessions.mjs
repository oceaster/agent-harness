/**
 * The conversations the reload probe seeds into a keyless fixture home, shared
 * by the seeding script and the probe so the two cannot drift apart.
 *
 * The ids follow the deployment's own shape (`session-inbox-<profile>-<agent>`)
 * because that is what a real conversation is called; nothing here depends on
 * the harness knowing them.
 */
export const SEEDED_SESSIONS = {
  /** Carries a three-item plan; the probe expands its strip. */
  alpha: 'session-inbox-person-probe-agent-alpha',
  /** Carries a two-item plan; proves the flag does not travel between conversations. */
  beta: 'session-inbox-person-probe-agent-beta',
  /** Never written to disk: the stale-key case (a stored value with no conversation). */
  orphan: 'session-inbox-person-probe-agent-cleared',
}

/** The plan each seeded conversation carries, in order. */
export const SEEDED_PLANS = {
  [SEEDED_SESSIONS.alpha]: ['alpha plan one', 'alpha plan two', 'alpha plan three'],
  [SEEDED_SESSIONS.beta]: ['beta plan one', 'beta plan two'],
}
