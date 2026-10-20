/**
 * Per-conversation disclosure state: which of a conversation's collapsible
 * panels the reader has opened. Disclosure belongs to the conversation it was
 * made in — two conversations keep their own expansions — so this store is
 * declared on the session-scoped `conversation.input.dock` slot and the engine
 * suffixes the persist key with the session id
 * (`dsh.conversation.disclosure.<sessionId>`). A value stored for a conversation
 * that no longer exists stays under its own key: no other session can read it,
 * because no other session resolves that scope key.
 *
 * Only the plan strip is here today. That is deliberate rather than partial: it
 * is the disclosure this deployment actually renders above the composer. The
 * chat-row disclosures (reasoning, context injection, compaction) mount by
 * transcript index (`key={i}` in AssistantMarkdown), so a persisted expansion
 * would re-expand whichever row later occupies that index — the wrong row in a
 * moved transcript, which is worse than losing the expansion. They stay
 * component-local until a row carries a stable identity.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Persisted disclosure state of one conversation. */
export interface ConversationDisclosureState {
  /** Plan strip (todo dock) collapsed; the strip default is collapsed. */
  planCollapsed: boolean
}

/** Annotation twin of the actions literal below (the export needs a declared return type). */
export type ConversationDisclosureActions = {
  setPlanCollapsed: (draft: ConversationDisclosureState, collapsed: boolean) => void
  togglePlan: (draft: ConversationDisclosureState) => void
}

/** The handle type the dock registration and its props share both name. */
export type ConversationDisclosureStoreHandle =
  EngineStoreHandle<ConversationDisclosureState, ConversationDisclosureActions>

/**
 * Create the conversation disclosure store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createConversationDisclosureStore(): ConversationDisclosureStoreHandle {
  return defineStore({
    // The strip starts collapsed (its pre-persist behaviour), so a conversation
    // nobody has expanded reads exactly as it did before this store existed.
    init: (): ConversationDisclosureState => ({ planCollapsed: true }),
    persist: 'dsh.conversation.disclosure',
    actions: {
      setPlanCollapsed: (d, collapsed: boolean) => { d.planCollapsed = collapsed },
      togglePlan: (d) => { d.planCollapsed = !d.planCollapsed },
    },
  })
}
