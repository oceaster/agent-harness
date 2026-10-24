/**
 * Whether the frame's current conversation is one a person can write into — the
 * layout's read of ui-conversation's read-only rule, which stays the single
 * authority for the fact:
 *
 *   packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx:21
 *     const readOnly = child || childSummary
 *
 * and that same file mounts the composer seat only when `!readOnly` (:134). A
 * worker (Epsilon) transcript, or a summary-only one, is read-only by
 * construction and must not paint writable chrome.
 *
 * The frame is a root-scope component, so it cannot call the session-scoped
 * `useSession` hook the two branches above read directly. It reads instead the
 * session LIST facts the runtime projects for exactly those branches:
 * `byId[current].origin === 'subagent'` is `childSummary`, and
 * `currentAddress !== undefined` is the addressed-subagent route that makes a
 * session's own `subagent` record non-null (`child`). The rule is not copied —
 * only its read is moved to the facts a root-scope caller can see; if
 * ConversationRoot's rule ever changes, this is the twin that changes with it.
 */
import type { SessionListState } from '@deepseek-ai/dsh-client-runtime/client'

/** The session-list facts the writability read needs (a snapshot subset). */
export type WritableFacts = Pick<SessionListState, 'current' | 'byId' | 'currentAddress'>

/**
 * Read writability off one session list snapshot.
 * @param list - the sessions service's list snapshot.
 * @returns true only when a current session exists, its summary is not a
 * subagent transcript, and the selection is not an addressed subagent route.
 */
export function isWritableConversation(list: WritableFacts): boolean {
  const current = list.current
  if (current === undefined) return false
  // The addressed route is the session-local `subagent` fact; ordinary
  // navigation leaves it undefined.
  if (list.currentAddress !== undefined) return false
  const summary = list.byId[current]
  if (summary === undefined) return false
  return summary.origin !== 'subagent'
}
