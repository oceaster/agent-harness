// Shared IconActions chrome for user and assistant messages: copy live, and an
// optional date-aware clock.

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IconCheckOutline16, IconCopyOutline16, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import { formatLatencySeconds, formatMessageClock, formatRunDuration, formatTokensPerSecond } from './message-chrome.ts'
import { useCalendarDay } from './use-calendar-day.ts'
import css from './MessageIconActions.module.css'

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
  /** Parent layout class composed onto the actions row. */
  className?: string | undefined
  /** The owning view's locale seat, passed down as a plain prop. */
  t: ChatViewSlotProps['t']
}

/**
 * Copy (/ clock) IconActions row shared by user and assistant chrome.
 * @param props - Copy text, event time, clock side, className, locale seat.
 * @returns The actions row element.
 */
export function MessageIconActions({
  text, time, runMs, ttftMs, tokensPerSecond, clock, className, t,
}: MessageIconActionsProps) {
  const day = useCalendarDay()
  // Same success chrome as CodeBlock: a short check swap after the write,
  // gated so re-clicks during the window neither re-copy nor stack timers.
  const [copied, setCopied] = useState(false)
  const copyPending = useRef(false)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const copyEpoch = useRef(0)
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
      <Tooltip label={copied ? t('copied') : t('copy')} side="bottom">
        <button type="button" className={css.action} aria-label={copied ? t('copied') : t('copy')} onClick={onCopy}>
          {copied ? <IconCheckOutline16 /> : <IconCopyOutline16 />}
        </button>
      </Tooltip>
      {clock === 'end' ? clockEl : null}
    </div>
  )
}
