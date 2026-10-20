/** Status precedence keeps active work and terminal failures distinct from unread completions. */
import type { InboxAgentRow } from './inbox-api.ts'

/** The status one row's presence dot can show. */
export type InboxPresence = NonNullable<InboxAgentRow['presence']>

/** Resolve the dot for an inbox row, using live running frames ahead of polled idle outcomes.
 *
 * A row whose own turn ended but whose subagents still run is working: descendants are
 * invisible in this appearance, so the parent row is the only place their work can show.
 * @param row - authenticated inbox row and live session facts.
 * @param active - conversations below this row's own session that are running right now, at any depth.
 * @returns the status rendered by the row.
 */
export function presenceOf(row: InboxAgentRow, active: number): InboxPresence {
  if (row.enabled === false) return 'offline'
  if (row.running || active > 0) return 'running'
  return row.presence === 'running' ? 'online' : row.presence ?? 'online'
}
