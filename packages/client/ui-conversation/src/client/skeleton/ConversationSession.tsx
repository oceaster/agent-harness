/** Strict per-session header/body content inserted into the resident conversation layout. */

import { useEffect, useSyncExternalStore } from 'react'
import type {
  ConversationSessionHeaderSlotProps, ConversationSessionSlotProps,
} from '../contract/slots.ts'
import type { ViewTab } from '../contract/views.ts'
import css from './ConversationRoot.module.css'

/** Full props composed from the strict session body contract. */
export type ConversationSessionProps = ConversationSessionSlotProps

/** Full props composed from the strict session header contract. */
export type ConversationSessionHeaderProps = ConversationSessionHeaderSlotProps

const DEFAULT_VIEW_ID = 'chat'

/** Resolve by id and keep stale persisted selections on the stable Chat fallback. */
function resolveActiveView(tabs: readonly ViewTab[], selectedId: string | null): ViewTab | undefined {
  const requestedId = selectedId ?? DEFAULT_VIEW_ID
  return tabs.find(view => view.id === requestedId)
    ?? tabs.find(view => view.id === DEFAULT_VIEW_ID)
}

export function ConversationSessionHeader({
  useSession, useSessions,
}: ConversationSessionHeaderProps) {
  // NOTHING. Owen, 2026-10-23: "when I open an epsilon chat to view it, there
  // should not be a top bar within the chat interface (currently shows the
  // `parent session name / sub-agent session name`, we don't expose this stuff
  // in our harness it's internal/non-user-facing only)."
  //
  // This header only ever painted for a read-only subagent transcript - a person's
  // own conversation returns null one line into the old body - and the one thing
  // it drew there was the parent/child breadcrumb, which is harness plumbing, not
  // product. With the breadcrumb gone there is nothing left for it to say, so it
  // says nothing and no empty bar is left occupying the top of the transcript.
  //
  // The reads below are kept because dropping them would change the hook order
  // between renders of the slot host that wraps this component; they are cheap
  // snapshots the surrounding shell already subscribes to.
  useSession(s => s.composerPhase)
  useSessions(s => Boolean(s.byId))
  return null
}

/**
 * Renders the active Session view inside the resident scrollport and keeps
 * the input draft mirrored while blank Hero chrome is visible.
 * @param props - Strict Session input/store, view ledger, and render shares.
 * @returns the active view area, or null while the Session remains blank.
 */
export function ConversationSession({
  sessionId, useSession, useInput, inputActions, useStore, actions,
  renderSlot, views, bindDraftMirror, releaseSessionImages,
}: ConversationSessionProps) {
  useSyncExternalStore(views.subscribe, views.version)
  const tabs = views.list()
  const selectedId = useStore(s => s.view)
  const active = resolveActiveView(tabs, selectedId)
  const composerPhase = useSession(s => s.composerPhase)
  const blank = useSession(s => s.blank)
  const inputState = useInput(s => s)
  const storedDraft = useStore(s => s.draft)
  // `?? null`: persisted snapshots from before the inspect field rehydrate without it.
  const inspect = useStore(s => s.inspect ?? null)

  useEffect(() => {
    if (inputState.draft === '' && storedDraft !== '') inputActions.setDraft(storedDraft)
    const unmirror = bindDraftMirror(actions.setDraft)
    return () => { unmirror() }
    // Mount-only (deps pinned to inputActions): later store writes come from
    // the machine mirror, not this seed effect.
  }, [inputActions])

  useEffect(() => () => {
    releaseSessionImages(sessionId)
  }, [releaseSessionImages, sessionId])

  if (blank && composerPhase === 'blank') return null
  return (
    <div className={css.viewArea}>
      {active !== undefined && renderSlot('conversation.view', {
        inspect,
        onInspectDone: () => { actions.setInspect(null) },
      }, { only: active.id })}
    </div>
  )
}
