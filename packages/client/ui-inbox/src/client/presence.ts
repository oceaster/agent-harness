/** Status precedence keeps active work and terminal failures distinct from unread completions. */
import type { InboxAgentRow } from './inbox-api.ts'
/** Resolve the dot for an inbox row, using live running frames ahead of polled idle outcomes.
 * @param row - authenticated inbox row and live session facts.
 * @returns the status rendered by the row.
 */
export function presenceOf(row: InboxAgentRow): NonNullable<InboxAgentRow['presence']> {
  if (row.enabled === false) return 'offline'
  if (row.running) return 'running'
  return row.presence === 'running' ? 'online' : row.presence ?? 'online'
}
