/** Accessible status dot with text available to assistive technology and hover. */
import type { InboxPresence } from './presence.ts'
import css from './InboxPanel.module.css'
/** Render a status dot independently of the agent portrait.
 * @param props - status and localized accessible label.
 * @returns a labelled dot.
 */
export function PresenceDot({ status, label }: { status: InboxPresence; label: string }) {
  return <span className={css.presenceDot} data-presence={status} role="img" aria-label={label} title={label} />
}
