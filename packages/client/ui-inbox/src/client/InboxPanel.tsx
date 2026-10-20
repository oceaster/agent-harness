/**
 * InboxPanel: the sidebar's browsing region for the prototype. One row per
 * agent with a 3-dot menu holding Clear. Wide renders the section header plus
 * rows; the rail renders one glyph per agent so the collapsed column still has
 * a body.
 *
 * SPIKE PROTOTYPE (branch spike/inbox-ui, throwaway). Presentation only:
 * every value arrives through the composed props shares, no ctx access.
 */
import { useState } from 'react'
import type { InboxPanelProps } from './slots.ts'
import css from './InboxPanel.module.css'

/**
 * Render the inbox region.
 * @param props - composed slot props (runtime share + injected face + locale seat).
 * @returns the inbox element tree.
 */
export function InboxPanel({ rows, wide, open, clear, t }: InboxPanelProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null)

  if (!wide) {
    return (
      <div className={css.rail} data-testid="ui-inbox-rail" aria-label={t('inbox.rail')}>
        {rows.map(row => (
          <button
            key={row.agent}
            type="button"
            className={css.railGlyph}
            data-testid={`ui-inbox-rail-${row.agent}`}
            aria-label={row.title}
            onClick={() => { open(row) }}
          >
            {row.title.slice(0, 1)}
          </button>
        ))}
      </div>
    )
  }

  return (
    <div className={css.panel} data-testid="ui-inbox-panel">
      <div className={css.header}>
        <span className={css.title}>{t('section.agents')}</span>
        <span className={css.marker} data-testid="ui-inbox-marker">{t('inbox.marker')}</span>
      </div>
      <ul className={css.list}>
        {rows.map(row => (
          <li key={row.agent} className={css.row} data-testid={`ui-inbox-row-${row.agent}`}>
            <button
              type="button"
              className={css.rowButton}
              data-testid={`ui-inbox-open-${row.agent}`}
              onClick={() => { open(row) }}
            >
              {row.title}
            </button>
            <button
              type="button"
              className={css.menuButton}
              aria-label={`${row.title} — ${t('inbox.clear')}`}
              data-testid={`ui-inbox-menu-${row.agent}`}
              onClick={() => { setMenuFor(current => (current === row.agent ? null : row.agent)) }}
            >
              ⋯
            </button>
            {menuFor === row.agent && (
              <div className={css.menu} data-testid={`ui-inbox-menu-body-${row.agent}`}>
                <button
                  type="button"
                  className={css.menuItem}
                  data-testid={`ui-inbox-clear-${row.agent}`}
                  onClick={() => {
                    clear(row)
                    setMenuFor(null)
                  }}
                >
                  {t('inbox.clear')}
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
