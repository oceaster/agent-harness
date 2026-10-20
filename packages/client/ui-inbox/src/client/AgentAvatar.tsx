/** The configured agent portrait, or two overlapping portraits for a channel. */
import css from './InboxPanel.module.css'

/** Render authenticated portraits with a text fallback for unavailable images.
 * @param props - participant ids and the decorative fallback glyph.
 * @returns a circular agent or channel avatar.
 */
export function AgentAvatar({ agents, label }: { agents: string[]; label: string }) {
  return <span className={css.avatar} aria-hidden="true">
    {label}
    {agents.slice(0, 2).map(agent => <img key={agent} alt="" draggable={false}
      className={agents.length > 1 ? css.pairAvatar : css.agentAvatar}
      src={'/v1/browser/inbox/avatars/' + encodeURIComponent(agent)}
      onError={(event) => { event.currentTarget.hidden = true }} />)}
  </span>
}
