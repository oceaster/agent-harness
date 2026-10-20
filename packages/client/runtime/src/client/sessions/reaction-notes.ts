/**
 * Reaction notes the log itself carries, folded into the badge one message
 * shows.
 *
 * A `reaction/note` is a log-only event: it never enters the ordered surface,
 * so no Conversation Definition claims it and it paints no transcript row
 * (pinned by `ui-conversation/tests/reaction-note-transcript.client.spec.ts`).
 * The badge therefore cannot come from the assembled Chat Nodes — it is a fold
 * of the raw event window the Session already holds, exactly like
 * {@link SessionQueueMirror} folds the durable queue edges.
 *
 * The fold is the whole truth and nothing else: last note per target wins, a
 * `removed` note drops the target, and there is no optimistic path — a click
 * writes a note through the wire and the badge moves when that note comes back
 * in the log. Reload, resume and a replayed window rebuild the identical map.
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'

/** The act one note records (mirrors the core `ReactionNoteEventData.action` union). */
export type SessionReactionAction = 'added' | 'removed' | 'changed'

/** The reaction one message currently carries, as the log last recorded it. */
export interface SessionReaction {
  /** Seq of the message this reaction belongs to. */
  readonly targetSeq: number
  /** The glyph, exactly as it was written to the log. */
  readonly emoji: string
  /** What the winning note recorded. */
  readonly action: SessionReactionAction
  /** Who reacted, as the writing client labelled them. */
  readonly actor: string
  /** Seq of the winning note — the only ordering evidence the fold needs. */
  readonly seq: number
}

const EMPTY: ReadonlyMap<number, SessionReaction> = new Map()

/** Narrow one raw event to a reaction note. */
function isReactionNote(event: SessionEvent): event is SessionEvent<'reaction/note'> {
  return event.type === 'reaction/note'
}

/** Session-owned fold of `reaction/note` events keyed by the message they target. */
export class SessionReactionNotes {
  private current: ReadonlyMap<number, SessionReaction> = EMPTY

  /**
   * The current immutable badge map.
   * @returns target message seq → its latest recorded reaction.
   */
  snapshot(): ReadonlyMap<number, SessionReaction> {
    return this.current
  }

  /**
   * Rebuild from a complete window (open, resync, gap repair, older page).
   * @param events - the contiguous raw window in ascending seq order.
   * @returns whether the map changed.
   */
  replace(events: readonly SessionEvent[]): boolean {
    const next = new Map<number, SessionReaction>()
    for (const event of events) {
      if (!isReactionNote(event)) continue
      applyNote(next, event)
    }
    if (sameEntries(this.current, next)) return false
    this.current = next.size === 0 ? EMPTY : next
    return true
  }

  /**
   * Fold one newly durable note.
   * @param event - newly contiguous Session event.
   * @returns whether the badge map changed.
   */
  accept(event: SessionEvent): boolean {
    if (!isReactionNote(event)) return false
    const next = new Map(this.current)
    const previous = next.get(event.data.targetSeq)
    applyNote(next, event)
    if (previous !== undefined && next.get(event.data.targetSeq) === previous) return false
    this.current = next
    return true
  }
}

/**
 * Fold one note into a working map: `added`/`changed` set the target,
 * `removed` clears it. A note is the record of an act, so the entry it leaves
 * keeps the note's own seq — that is what makes the last note win.
 * @param target - working map to mutate.
 * @param event - the reaction note.
 */
function applyNote(target: Map<number, SessionReaction>, event: SessionEvent<'reaction/note'>): void {
  const { targetSeq, emoji, action, actor } = event.data
  if (action === 'removed') {
    target.delete(targetSeq)
    return
  }
  target.set(targetSeq, { targetSeq, emoji, action, actor, seq: event.seq })
}

/** Reference-compare two badge maps entry by entry. */
function sameEntries(
  left: ReadonlyMap<number, SessionReaction>,
  right: ReadonlyMap<number, SessionReaction>,
): boolean {
  if (left.size !== right.size) return false
  for (const [key, value] of left) {
    if (right.get(key) !== value) return false
  }
  return true
}
