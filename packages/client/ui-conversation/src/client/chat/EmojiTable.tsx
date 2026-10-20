// The reaction affordance's emoji table: a small fixed set of glyphs in a grid,
// anchored under the React button. It owns nothing but "is it open" — the
// reaction itself lives in the log (see MessageIconActions' badge), so a choice
// here posts a note and closes; nothing is painted optimistically.
//
// Keyboard: the grid is a listbox whose options are focused programmatically
// (the table is opened from a button, so focus arrives inside it immediately).
// Arrow keys move, Home/End jump, Enter/Space choose, Escape closes, Tab leaves.
// The parent returns focus to the React button whenever the table closes.

import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import css from './EmojiTable.module.css'

/**
 * The fixed reaction set: one dozen glyphs, the reactions people actually use
 * on a message. Deliberately not a searchable picker — the owner asked for "a
 * basic emoji table".
 */
export const REACTION_EMOJI: readonly string[] = [
  '👍', '❤️', '😄', '🎉', '😮', '😢',
  '🙏', '👀', '🔥', '✅', '❌', '🤔',
]

/** Two rows of six, so the vertical arrow step matches what the reader sees. */
const GRID_COLUMNS = 6

export interface EmojiTableProps {
  /** Id of the row's emoji table, so the triggering button can own the `aria-controls` pair. */
  readonly id: string
  /**
   * The element the table hangs off: the row's React-button wrapper. A pointer
   * press inside it — including on the React button itself — belongs to the
   * button's own toggle rather than to the dismissal, so pressing the button
   * while the table is open closes it instead of closing then reopening.
   */
  readonly anchor: RefObject<HTMLElement | null>
  /** The glyph the log currently records for this message, marked as the chosen one. */
  readonly current: string | undefined
  /** Choose one glyph (the parent posts the note and closes). */
  readonly onChoose: (emoji: string) => void
  /** Dismiss without choosing (Escape, outside click). */
  readonly onDismiss: () => void
  /** The owning view's locale seat. */
  readonly t: ChatViewSlotProps['t']
}

/**
 * The dismissible emoji table.
 * @param props - table id, anchor element, current glyph, choose/dismiss callbacks, locale seat.
 * @returns the anchored table element.
 */
export function EmojiTable({ id, anchor, current, onChoose, onDismiss, t }: EmojiTableProps) {
  const tableRef = useRef<HTMLDivElement | null>(null)
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([])
  const labelId = useId()

  // Focus the applied glyph when there is one, so "choose it again to un-react"
  // is the first thing a keyboard reader can do; otherwise the first glyph.
  useEffect(() => {
    const index = current === undefined ? 0 : Math.max(0, REACTION_EMOJI.indexOf(current))
    optionRefs.current[index]?.focus()
  }, [current])

  // An outside click dismisses. Pointerdown (not click) so the dismissal lands
  // before the outside target's own handler, without swallowing that click.
  useEffect(() => {
    const onPointerDown = (event: PointerEvent): void => {
      const root = tableRef.current
      if (root === null) return
      const trigger = anchor.current
      const target = event.target
      if (!(target instanceof Node)) return
      // The trigger's own press is the toggle's business, not a dismissal.
      const inside = (trigger !== null && trigger.contains(target)) || root.contains(target)
      if (!inside) onDismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [anchor, onDismiss])

  /** Roving index of the focused option; the first one when focus drifted. */
  const focusedIndex = (): number => {
    const active = document.activeElement
    const index = optionRefs.current.findIndex(option => option === active)
    return index < 0 ? 0 : index
  }

  const move = (delta: number): void => {
    const count = REACTION_EMOJI.length
    const next = (focusedIndex() + delta + count) % count
    optionRefs.current[next]?.focus()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    switch (event.key) {
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        onDismiss()
        return
      case 'ArrowRight':
        event.preventDefault()
        move(1)
        return
      case 'ArrowLeft':
        event.preventDefault()
        move(-1)
        return
      case 'ArrowDown':
        event.preventDefault()
        move(GRID_COLUMNS)
        return
      case 'ArrowUp':
        event.preventDefault()
        move(-GRID_COLUMNS)
        return
      case 'Home':
        event.preventDefault()
        optionRefs.current[0]?.focus()
        return
      case 'End':
        event.preventDefault()
        optionRefs.current[REACTION_EMOJI.length - 1]?.focus()
        return
      default:
    }
  }

  return (
    <div
      ref={tableRef}
      id={id}
      className={css.table}
      role="group"
      aria-labelledby={labelId}
      onKeyDown={onKeyDown}
      data-reaction-table=""
    >
      <span id={labelId} className={css.label}>{t('reaction.table')}</span>
      <div className={css.grid} role="listbox" aria-labelledby={labelId}>
        {REACTION_EMOJI.map((emoji, index) => (
          <button
            key={emoji}
            ref={(element) => { optionRefs.current[index] = element }}
            type="button"
            role="option"
            aria-selected={emoji === current}
            aria-label={t('reaction.option', { emoji })}
            tabIndex={-1}
            className={emoji === current ? `${css.option} ${css.optionCurrent}` : css.option}
            data-reaction-emoji={emoji}
            onClick={() => { onChoose(emoji) }}
          >
            {emoji}
          </button>
        ))}
      </div>
    </div>
  )
}
