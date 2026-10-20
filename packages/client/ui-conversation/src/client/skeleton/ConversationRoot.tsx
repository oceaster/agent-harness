// Conversation skeleton. An unselected inbox shows the branded welcome screen;
// a selected conversation owns the branded empty placeholder, message chain and
// docked composer.

import { useCallback, useRef } from 'react'
import type { ConversationSlotProps, InputZone } from '../contract/slots.ts'
import { HeroGlow } from './HeroGlow.tsx'
import css from './ConversationRoot.module.css'

/** Full props composed from the slot contract. */
export type ConversationRootProps = ConversationSlotProps

export function ConversationRoot({
  sessionId, useSession, useSessions, useInput, useComposerBlock,
  renderSlot, renderSlotChain, t,
}: ConversationRootProps) {
  const openState = useSession(s => s.openState)
  const composerPhase = useSession(s => s.composerPhase)
  const child = useSession(s => Boolean(s.subagent))
  const childSummary = useSessions(s => sessionId !== undefined && s.byId[sessionId]?.origin === 'subagent')
  const readOnly = child || childSummary
  const pending = useSession(s => s.pending) ?? []
  const session = useSession(s => s)
  const inputState = useInput(s => s)
  const summaryBlank = useSessions(s => sessionId === undefined ? undefined : s.byId[sessionId]?.blank)
  // A plugin this package cannot import (ui-model-selection) says this session cannot
  // send; its reason is already localized by whoever raised it.
  const composerBlock = useComposerBlock(block => block)

  // Publishes the seat's live height as --dsh-composer-height on the scroll
  // body so floating controls (ChatView back-to-bottom) clear the composer as
  // it grows. Callback ref, not an effect; stable identity prevents observer
  // churn while the first blank session fills the resident body outlet.
  const seatObserver = useRef<ResizeObserver | null>(null)
  const seatResizeRef = useCallback((seat: HTMLDivElement | null): void => {
    seatObserver.current?.disconnect()
    seatObserver.current = null
    const scroller = seat?.parentElement ?? null
    if (seat === null || scroller === null) return
    seatObserver.current = new ResizeObserver(() => {
      scroller.style.setProperty('--dsh-composer-height', `${seat.offsetHeight}px`)
    })
    seatObserver.current.observe(seat)
  }, [])

  // While a session is still replaying (loading + blank) the composer stays
  // hidden: a session whose history has not landed may still turn out to hold
  // a transcript, and a composer that flashes into place then moves reads as a
  // reload. Exemption: a session the list summary already proves blank can only
  // land on the placeholder, so hiding would blank the column for the whole
  // history round-trip (the startup auto-selection flash) for nothing.
  // The exemption is deliberately open-state-wide, not loading-only: a
  // summary-blank session shows the placeholder before its open starts (`cold`)
  // and after one fails (`error`) for the same reason — there is no history.
  const settling = sessionId !== undefined && composerPhase === 'blank' && openState === 'loading'
    && summaryBlank !== true
  // A selected conversation with no messages: the household mark above the
  // docked composer, which sits exactly where an active chat puts it. The mark
  // states "no messages", so it is painted only when emptiness is known — the
  // open landed (`open`), or the list summary proves the session blank (the
  // same proof the settling exemption trusts, before a `cold` open and after a
  // failed one). A session whose open is still in flight or has failed may hold
  // a transcript nobody has read yet, and ChatView renders its history failure
  // in this same body, so the body stays bare there. The gate subsumes
  // `settling`, which is strictly a `loading` open with no summary proof.
  const empty = composerPhase === 'blank' && (openState === 'open' || summaryBlank === true)
  const zone: InputZone | undefined =
    session === undefined || inputState === undefined ? undefined : { session, input: inputState }

  if (sessionId === undefined) {
    return <section className={css.inboxWelcome} data-testid="inbox-welcome" aria-label={t('welcome.select')}>
      <div className={css.welcomeArt} aria-hidden="true">
        <HeroGlow className={css.welcomeGlow} />
        <div className={css.welcomeLogo} />
      </div>
      <div className={css.welcomeBottom}>
        <p className={css.welcomePrompt}>- {t('welcome.select')} -</p>
        <footer className={css.welcomeFooter}><span>© {new Date().getFullYear()} Easter LTD</span><span>Numquam Succumbe</span></footer>
      </div>
    </section>
  }

  // A real conversation owns the composer; the unselected screen has no controls.
  const blocked = composerBlock !== undefined
  const inputBar = renderSlot('conversation.composer.bar', {
    ...(blocked
    // `blocked`, not `disabled`: the bar refuses input either way, but a
    // block keeps the model seat live because choosing a model is how the
    // user clears it.
      ? { blocked: composerBlock, placeholder: composerBlock.reason }
      : {}),
    overlay: renderSlot('conversation.input.overlay', {}),
    leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),
    rightItems: zone === undefined ? null : renderSlot('conversation.input.right', zone),
    // The persistent inbox composer has no diagnostic statistics footer.
    footer: null,
  })

  const composerBar = (
    <div className={css.composerStack}>
      {zone !== undefined && renderSlot('conversation.input.dock', zone)}
      {inputBar}
    </div>
  )

  const phase = settling ? 'settling' : 'active'
  const composer = renderSlotChain(
    'conversation.composer',
    { interactions: pending, session },
    { fallback: composerBar, overlay: true },
  )

  // Sticky wraps the whole chain output (fallback + elected overlay), not
  // only `.composerStack`: overlay:true renders those as siblings, and sticky
  // on the fallback alone would leave Question/Approval panels at the content
  // end off-screen when the user is not pinned to the floor.
  const composerSeat = (
    <div ref={seatResizeRef} className={css.composerSeat} data-composer-seat="">
      {composer}
    </div>
  )

  return (
    <div className={css.root} data-phase={phase}>
      {renderSlot('conversation.session.header', {})}
      <div className={css.scrollBody} data-conversation-scroll="">
        {renderSlot('conversation.session', {})}
        {empty && (
          <div className={css.conversationEmpty} data-testid="conversation-empty" aria-hidden="true">
            <HeroGlow className={css.welcomeGlow} />
            <div className={css.welcomeLogo} />
          </div>
        )}
        {!readOnly && composerSeat}
      </div>
    </div>
  )
}
