// @vitest-environment node
/**
 * Writability read (writable.ts): the layout's mirror of ui-conversation's
 * read-only rule (ConversationRoot.tsx:21 `const readOnly = child || childSummary`).
 * The point of the spec is the "same fact, not a second copy" requirement: every
 * branch of that rule must answer read-only here too, and an ordinary writable
 * conversation must be the only shape that answers writable.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { isWritableConversation, type WritableFacts } from '@deepseek-ai/dsh-client-ui-layout/src/client/writable.ts'

const ID = 's-chat' as SessionId

/**
 * Build the list subset the predicate reads.
 * @param over - per-case overrides (extra rows, origin, addressed route, no selection).
 * @returns one session-list snapshot subset.
 */
function list(over: {
  current?: SessionId | undefined
  origin?: 'subagent'
  addressed?: boolean
  row?: boolean
} = {}): WritableFacts {
  const current = 'current' in over ? over.current : ID
  const rows: SessionListState['byId'] = {}
  if (over.row !== false && current !== undefined) {
    rows[current] = {
      id: current,
      displayTitle: 'Chat',
      running: false,
      blank: false,
      updatedAt: 1,
      ...(over.origin === undefined ? {} : { origin: over.origin }),
    }
  }
  return {
    current,
    byId: rows,
    currentAddress: over.addressed === true
      ? { parentSessionId: 's-parent' as SessionId, childSessionId: ID, mode: 'single' }
      : undefined,
  } as WritableFacts
}

describe('isWritableConversation', () => {
  it('is writable for an ordinary conversation (neither read-only branch)', () => {
    expect(isWritableConversation(list())).toBe(true)
  })

  it('is read-only for a subagent transcript (the `childSummary` branch)', () => {
    expect(isWritableConversation(list({ origin: 'subagent' }))).toBe(false)
  })

  it('is read-only on an addressed subagent route (the session-local `subagent` branch)', () => {
    expect(isWritableConversation(list({ addressed: true }))).toBe(false)
  })

  it('is read-only with no current session at all (the inbox hero, a channel page)', () => {
    expect(isWritableConversation(list({ current: undefined }))).toBe(false)
  })

  it('is read-only when the list has no row for the current id (still arriving)', () => {
    expect(isWritableConversation(list({ row: false }))).toBe(false)
  })

  it('stays writable for a blank writable session: a fresh chat is a chat', () => {
    // `blank` is not part of the read-only rule — the details panel gates on it,
    // writability does not.
    const blank = list()
    blank.byId[ID] = { ...blank.byId[ID]!, blank: true }
    expect(isWritableConversation(blank)).toBe(true)
  })
})
