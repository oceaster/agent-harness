/**
 * ModelSelect's injected face. The target 'conversation.input.model' seat is
 * declared (children table) and typed by ui-conversation's composer-bar
 * entry; this package only contributes the single occupant, so no SlotMap
 * merge lives here.
 */
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ModelDirectoryState } from './directory.ts'

/**
 * One explicit effort policy — the household agent table as a SINGLE shape the
 * control renders, never four special cases in the JSX. Four instances cover
 * every agent:
 *
 * - Diana — `{ word: 'Off', opens: false, editable: false }`: the control stays
 *   on screen reading `Off`, and no dialog can be opened.
 * - Darwin — `{ word: 'Max', opens: false, editable: false }`: likewise, `Max`.
 * - Delta — `{ word: 'Dynamic', opens: true, editable: false, treeEfforts: [...] }`:
 *   the dialog opens read-only, its value always reads `Dynamic`, and its bar
 *   sits at the highest effort anywhere in Delta's own session tree.
 * - A read-only worker conversation — `{ word: <that ticket's level>, opens: true,
 *   editable: false }`: the dialog opens read-only at the level the coordinator
 *   delegated, not the worker's own.
 *
 * A conversation whose deployment publishes no policy reads
 * {@link ORDINARY_EFFORT_POLICY}: visible, openable and editable — the vanilla
 * harness behaviour this control has always had.
 */
export interface EffortPolicy {
  /**
   * The word painted in place of a level name — the deployment's copy, never a
   * locale key: `Off`, `Max`, `Dynamic`, or a delegated worker's level name.
   * Absent = paint the current level's own name.
   */
  word?: string
  /**
   * Whether the trigger opens the dialog. `false` keeps the chip on screen,
   * disabled, with no `aria-haspopup` — a dialog that cannot exist must not be
   * announced as one.
   */
  opens: boolean
  /**
   * Whether the dialog may write a selection. `false` disables the slider and
   * makes {@link ModelSelectInjected.select} unreachable from this control: a
   * lock that can still write is worse than no lock.
   */
  editable: boolean
  /**
   * Effort ids of every conversation BELOW this one (its uninterrupted
   * subagent subtree — the same walk `indexSubagentDescendants` counts, where an
   * ordinary fork terminates propagation). The bar sits at the highest of them,
   * or at this session's own level when that is higher.
   * Absent = the bar tracks this session's own level only.
   */
  treeEfforts?: readonly string[]
  /**
   * PARKED — DO NOT WIRE YET. Owen deferred the read-only worker case on
   * 2026-10-24 ("Neither - skip it for now"): a read-only worker conversation
   * mounts no composer at all, so there is no seat to paint. The control still
   * renders this shape correctly (a locked dialog on a supplied level track),
   * and its unit test stays green, so the work is kept rather than deleted; it
   * becomes reachable only if a worker surface ever mounts the seat. Until
   * then nothing in the deployment sets it, and `index.ts` deliberately does
   * not widen `available` for addressed subagent sessions.
   *
   * A level track the policy supplies itself, for a conversation whose own
   * model directory can never load. Absent = the directory's own offer.
   */
  track?: {
    /** Level labels, lowest first. */
    names: readonly string[]
    /** This conversation's own level on that track. */
    index: number
  }
}

/** The ordinary conversation's policy: everything visible, openable and editable. */
export const ORDINARY_EFFORT_POLICY: EffortPolicy = { opens: true, editable: true }

/** Injected business face of the composer model seat. */
export interface ModelSelectInjected {
  /** Whether this session renders the control at all. */
  available: boolean
  /**
   * This session's effort policy, live: the control re-reads it on every
   * publish, so a worker whose level moves moves Delta's bar with it.
   */
  policy: ObservableSnapshot<EffortPolicy>
  /** The session's shared directory store (same instance the /model popup reads). */
  directory: SnapshotStore<ModelDirectoryState>
  /** Refresh the advisory directory (fire-and-forget; errors land on the store). */
  load: () => void
  /**
   * Select a complete provider/model/reasoning selection.
   * @param selection - model selection and optional adapter-owned effort.
   * @returns whether the host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
}
