/**
 * Convert a durable failure into copy that is safe to expose in the GUI.
 * @param failure - Failure value preserved by the session event.
 * @returns Display-safe copy for client projections.
 */
export function displayFailureMessage(failure: unknown): string {
  if (failure === null || typeof failure !== 'object') return String(failure)
  const record = failure as { code?: unknown; message?: unknown }
  // Provider AUTH messages may echo a masked or partially preserved credential.
  // Keep the raw diagnostic in the session log, but never project it into UI state.
  if (record.code === 'AUTH') return 'API key is invalid'
  return typeof record.message === 'string' ? record.message : JSON.stringify(failure)
}

/**
 * Failure codes that mean the agent could not be reached at all, rather than the
 * request being wrong: an exhausted quota, a rate limit, a failing or overloaded
 * provider, a transport blip, an empty answer, or a timeout.
 *
 * They are the transient half of the taxonomy — the fix is to wait, not to
 * change what was asked — which is why the transcript replaces their raw
 * provider text (`… no_credit, recovers in 86227s`) with one sentence telling
 * the reader to try again shortly. That countdown is a worst-case gateway
 * cooldown and was repeatedly read as a hard deadline, while credit in practice
 * comes back within minutes.
 *
 * Deliberately excluded: `AUTH` (an invalid key never fixes itself) and the
 * request-shaped codes (`INVALID_REQUEST`, `CONTEXT_WINDOW_EXCEEDED`,
 * `ABORTED`), whose own message tells the reader something actionable.
 */
const UNAVAILABLE_FAILURE_CODES: ReadonlySet<string> = new Set([
  'QUOTA',
  'RATE_LIMIT',
  'SERVER',
  'TIMEOUT',
  'TRANSPORT',
  'EMPTY_RESPONSE',
])

/**
 * Whether a failure means the agent was temporarily unavailable.
 * @param code - stable machine code preserved beside the failure.
 * @returns true when the only sensible advice is to try again in a few minutes.
 */
export function isUnavailableFailureCode(code: string | undefined): boolean {
  return code !== undefined && UNAVAILABLE_FAILURE_CODES.has(code)
}
