// @vitest-environment jsdom
/**
 * Conversation disclosure store: one conversation's panel expansions.
 * The acceptance that matters is the SCOPING — two conversations keep their own
 * flags, and a stored value for a conversation that no longer exists cannot be
 * read by another conversation.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createConversationDisclosureStore } from '../src/client/disclosure-store.ts'

const PREFIX = 'dsh.conversation.disclosure'
const ALPHA = 'session-inbox-owen-delta'
const BETA = 'session-inbox-owen-darwin'
const GONE = 'session-inbox-owen-diana'

beforeEach(() => { localStorage.clear() })
afterEach(() => { localStorage.clear() })

describe('conversation disclosure store', () => {
  it('defaults to the collapsed strip the panel shipped with', () => {
    const store = createConversationDisclosureStore().create(ALPHA)
    expect(store.getSnapshot()).toEqual({ planCollapsed: true })
  })

  it('suffixes the persist key with the session id, and nothing else', () => {
    const store = createConversationDisclosureStore().create(ALPHA)
    store.actions.togglePlan()
    expect(JSON.parse(localStorage.getItem(`${PREFIX}.${ALPHA}`) ?? 'null')).toEqual({ planCollapsed: false })
    // Root instances of the same handle would write the bare prefix; a
    // session-scoped create must never do that.
    expect(localStorage.getItem(PREFIX)).toBeNull()
  })

  it('rehydrates the expansion for the same conversation — the reload case', () => {
    const before = createConversationDisclosureStore().create(ALPHA)
    before.actions.togglePlan()
    // A reload rebuilds the instance over the same storage.
    const after = createConversationDisclosureStore().create(ALPHA)
    expect(after.getSnapshot().planCollapsed).toBe(false)
  })

  it('keeps two conversations independent in both directions', () => {
    const alpha = createConversationDisclosureStore().create(ALPHA)
    const beta = createConversationDisclosureStore().create(BETA)
    alpha.actions.setPlanCollapsed(false)
    // Beta was never touched: it must not inherit alpha's expansion.
    expect(beta.getSnapshot().planCollapsed).toBe(true)
    beta.actions.setPlanCollapsed(false)
    alpha.actions.setPlanCollapsed(true)
    // And a later write to alpha must not disturb beta's own value.
    expect(createConversationDisclosureStore().create(BETA).getSnapshot().planCollapsed).toBe(false)
    expect(createConversationDisclosureStore().create(ALPHA).getSnapshot().planCollapsed).toBe(true)
  })

  it('does not leak a stored value from a conversation that no longer exists', () => {
    // The conversation was cleared/renamed: its key stays behind.
    localStorage.setItem(`${PREFIX}.${GONE}`, JSON.stringify({ planCollapsed: false }))
    const other = createConversationDisclosureStore().create(ALPHA)
    // A different session resolves a different storage identity, so the
    // orphaned value cannot be read into this conversation's UI.
    expect(other.getSnapshot().planCollapsed).toBe(true)
    // The orphan is untouched — clearing it is the lifecycle's job, not a
    // side effect of some other conversation booting.
    expect(localStorage.getItem(`${PREFIX}.${GONE}`)).toBe('{"planCollapsed":false}')
  })

  it('notifies subscribers on each write (the dock re-renders from this)', () => {
    const store = createConversationDisclosureStore().create(ALPHA)
    let ticks = 0
    store.subscribe(() => { ticks += 1 })
    store.actions.togglePlan()
    store.actions.togglePlan()
    expect(ticks).toBe(2)
    expect(store.getSnapshot().planCollapsed).toBe(true)
  })
})
