// Shared IconActions chrome for user and assistant messages: copy live, an
// optional date-aware clock, and — for a row that owns a durable message — a
// React button with a small emoji table and the badge that table produces.
//
// The badge is the log's own fold (`ChatNodeReaction.reaction`, derived from the
// `reaction/note` events the host streams), never local state: a choice here
// posts one note and closes the table, and the badge appears when that note
// comes back. Nothing is painted optimistically, so a refused write leaves the
// row exactly as it was and says why.

import { useCallback, useEffect, useId, useRef, useState } from 'react'
import {
  IconCheckOutline16, IconCopyOutline16, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeReaction, ChatViewSlotProps } from '../contract/slots.ts'
import { EmojiTable } from './EmojiTable.tsx'
import { formatLatencySeconds, formatMessageClock, formatRunDuration, formatTokensPerSecond } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

/**
 * The React affordance's glyph. Deliberately local rather than a
 * `ui-primitives` icon: this package owns the reaction affordance, and the
 * shared icon set has no reaction glyph to borrow.
 */
function IconReactOutline16() {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden>
      <circle cx="8" cy="8" r="6.35" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="5.9" cy="6.5" r="0.85" fill="currentColor" />
      <circle cx="10.1" cy="6.5" r="0.85" fill="currentColor" />
      <path
        d="M5.25 9.35c.72 1.02 1.64 1.55 2.75 1.55s2.03-.53 2.75-1.55"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  )
}

export interface MessageIconActionsProps {
  /** Plain text the copy action writes. */
  text: string
  /** Unix epoch ms for the clock label; omitted for transient messages. */
  time?: number | undefined
  /** Turn wall time in ms, appended to the clock as `· Ran for 15s`; omitted when the turn's start is unknown. */
  runMs?: number | undefined
  /** Turn first-step TTFT in ms, appended as `· TTFT 1.2s`; omitted when unrecorded. */
  ttftMs?: number | undefined
  /** Turn decode throughput, appended as `· 34 tok/s`; omitted when unrecorded. */
  tokensPerSecond?: number | undefined
  /** Clock before icons (user) or after (assistant). */
  clock: 'start' | 'end'
  /**
   * Reaction state for this row's target message. Omitted for rows with no
   * durable message to target (a pending steering projection), which then show
   * no React affordance at all.
   */
  reaction?: ChatNodeReaction | undefined
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Copy (/ clock / react) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, reaction state, className, locale seat.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, runMs, ttftMs, tokensPerSecond, clock, reaction, className, t,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  // Same success chrome as CodeBlock: a short check swap after the write,
  // gated so re-clicks during the window neither re-copy nor stack timers.
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)
  // Table visibility is the only reaction-adjacent state this row owns; the
  // reaction itself lives in the log.
  const [tableOpen, setTableOpen] = useState(false)
  const [reactError, setReactError] = useState<string | null>(null)
  const reactButton = useRef<HTMLButtonElement | null>(null)
  const tableId = useId()
  const current = reaction?.reaction?.emoji
  // A row that stops owning a reactable message must not keep a table open.
  useEffect(() => {
    if (reaction !== undefined) return
    setTableOpen(false)
    setReactError(null)
  }, [reaction])
  useEffect(() => () => {
    copyEpoch.current += 1
    copyPending.current = false
    if (copyTimer.current !== null) clearTimeout(copyTimer.current)
  }, [])
  const onCopy = useCallback(() => {
    if (copied || copyPending.current) return
    const epoch = copyEpoch.current
    copyPending.current = true
    void writeClipboard(text).then((ok) => {
      if (epoch !== copyEpoch.current) return
      copyPending.current = false
      if (!ok) return
      setCopied(true)
      copyTimer.current = window.setTimeout(() => {
        copyTimer.current = null
        setCopied(false)
      }, 1000)
    })
  }, [copied, text])
  // Every dismissal route (Escape, outside click, choosing an entry) closes the
  // table and hands focus back to the button that opened it.
  const closeTable = useCallback(() => {
    setTableOpen(false)
    reactButton.current?.focus()
  }, [])
  /**
   * The act a chosen glyph records: the glyph already applied is taken back,
   * a different glyph replaces it, and the first glyph is added. Decided from
   * the log's state, so a reload reaches the same conclusion — the three acts
   * are three notes, never a local toggle.
   */
  const actFor = (emoji: string): 'added' | 'removed' | 'changed' => {
    if (current === undefined) return 'added'
    return current === emoji ? 'removed' : 'changed'
  }
  const onChoose = (emoji: string): void => {
    if (reaction === undefined) return
    const action = actFor(emoji)
    closeTable()
    setReactError(null)
    // Fire and forget: the badge moves when the note streams back, and a
    // refusal is reported here instead of being painted as success.
    void reaction.react(emoji, action).catch((error: unknown) => {
      setReactError(error instanceof Error ? error.message : String(error))
    })
  }
  // The dot is decorative and stays hidden, but its margins separate the
  // readings only on screen: without the flanking spaces a reader hears one
  // run-on string ("Ran for 13sTTFT 0.2s12 tok/s") instead of three facts.
  const clockEl = time === undefined ? null : (
    <span className={clock === 'start' ? css.timeStart : css.timeEnd}>
      {formatMessageClock(time, t, day)}
      {runMs !== undefined && (
        <>
          {' '}
          <span className={css.runTimeDot} aria-hidden>·</span>
          {' '}
          {t('message.ranFor', { duration: formatRunDuration(runMs, t) })}
        </>
      )}
      {ttftMs !== undefined && (
        <>
          {' '}
          <span className={css.runTimeDot} aria-hidden>·</span>
          {' '}
          {t('message.ttft', { seconds: formatLatencySeconds(ttftMs) })}
        </>
      )}
      {tokensPerSecond !== undefined && (
        <>
          {' '}
          <span className={css.runTimeDot} aria-hidden>·</span>
          {' '}
          {t('message.tokensPerSecond', { tps: formatTokensPerSecond(tokensPerSecond) })}
        </>
      )}
    </span>
  )
  return (
    <div className={className === undefined ? css.actions : `${css.actions} ${className}`}>
      {clock === 'start' ? clockEl : null}
      {current !== undefined && (
        <span
          className={css.badge}
          role="img"
          aria-label={t('reaction.current', { emoji: current })}
          title={t('reaction.current', { emoji: current })}
          data-reaction-badge={current}
        >
          {current}
        </span>
      )}
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        </button>
      </Tooltip>
      {reaction !== undefined && (
        <span className={css.reactionAnchor}>
          <Tooltip label={t('reaction.button')} side="bottom">
            <button
              ref={reactButton}
              type="button"
              className={css.action}
              aria-label={t('reaction.button')}
              aria-haspopup="true"
              aria-expanded={tableOpen}
              aria-controls={tableOpen ? tableId : undefined}
              onClick={() => {
                setReactError(null)
                setTableOpen(open => !open)
              }}
            >
              <IconReactOutline16 />
            </button>
          </Tooltip>
          {tableOpen && (
            <EmojiTable
              id={tableId}
              current={current}
              onChoose={onChoose}
              onDismiss={closeTable}
              t={t}
            />
          )}
        </span>
      )}
      {reactError !== null && (
        <span className={css.reactError} role="status" data-reaction-error="">
          {t('reaction.failed', { reason: reactError })}
        </span>
      )}
      {clock === 'end' ? clockEl : null}
    </div>
  )
}
