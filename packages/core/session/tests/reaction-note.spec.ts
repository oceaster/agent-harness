/**
 * Reaction notes: a log-only event kind that reaches the model and nothing else.
 *
 * Four properties are pinned here because all four are defaults a later change
 * could silently reverse:
 *
 * 1. the envelope marker — `Session.append('reaction/note', …)` writes
 *    `ignorable: true`, so a reader that does not know the kind skips it
 *    instead of refusing the whole log;
 * 2. the model projection — the note appears in `deriveMessages()` AT ITS LOG
 *    POSITION among the surface messages (never appended at the tail, which
 *    pinned every note to the end of every later request), with a seq-derived
 *    id and a plugin source, while the ordered surface never sees it;
 * 3. the two free exclusions — the transcript fold (`foldSurface`, which the
 *    browser registry and the compaction span builder both fold) contains no
 *    note, so nothing renders it and nothing summarises it;
 * 4. the lifetime rule — a note is derived only while its `targetSeq` is still
 *    a current surface node: once the message leaves the context, so does the
 *    reaction to it. Lifetime is a pure function of the log, so a from-scratch
 *    replay derives exactly what the live session derived.
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, foldSurface, isModelNoteEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import { deriveEventMessage } from '@deepseek-ai/dsh-session/surface'

/** One ordinary two-message turn: prompt, reply, tool result, closed turn. */
function conversation(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'what is in the shed' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'checking' }, { type: 'tool-call', id: CallId('c1'), name: 'ls', arguments: '{}' }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId('c1'),
      content: [{ type: 'text', text: 'a rake and a mower' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** Append one note the way the RPC does. */
function note(session: Session, targetSeq: number, emoji = '👍'): number {
  const event = session.append('reaction/note', {
    targetSeq,
    emoji,
    actor: 'owen',
    action: 'added',
  }, { ignorable: true })
  return event.seq
}

/** Every text block of one message, joined. */
function textOf(message: Message): string {
  return message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
}

/** Human-readable one-line rendering of any derived message, tool results included. */
function lineOf(message: Message): string {
  return message.content.flatMap((block) => {
    if (block.type === 'text') return [block.text]
    if (block.type === 'tool-result') {
      return block.content.flatMap(inner => inner.type === 'text' ? [inner.text] : [])
    }
    return []
  }).join('\n')
}

describe('reaction/note envelope', () => {
  it('writes the ignorable marker, and only through an explicit intent', () => {
    const session = Session.create(SessionId('note-envelope'))
    conversation(session)
    const seq = note(session, 1)

    const event = session.events[seq]
    expect(event?.type).toBe('reaction/note')
    expect(event?.ignorable).toBe(true)
    // The marker is an envelope field, not payload: nothing a client sends can
    // smuggle it in, and the event data stays exactly the four documented keys.
    expect(event?.data).toEqual({ targetSeq: 1, emoji: '👍', actor: 'owen', action: 'added' })
    // Durable shape: the log is JSON, so the marker is what a restart reads.
    expect(JSON.parse(JSON.stringify(event))).toHaveProperty('ignorable', true)
  })

  it('omits the marker when the caller does not ask for it', () => {
    const session = Session.create(SessionId('note-no-marker'))
    conversation(session)
    const event = session.append('reaction/note', {
      targetSeq: 1, emoji: '🎉', actor: 'hannah', action: 'removed',
    })
    expect('ignorable' in event).toBe(false)
  })

  it('refuses an ignorable marker on a surface event', () => {
    const session = Session.create(SessionId('note-surface-marker'))
    conversation(session)
    const message = createUserMessage({
      content: [{ type: 'text', text: 'x' }], source: { kind: 'user' },
    })
    // A surface event is reconstructed history: skipping an unrecognized one
    // would silently shorten the model's conversation, so the intent is
    // contradictory and the untyped path is rejected at the append site.
    expect(() => session.append(
      'user/message',
      message,
      { surfaceOp: 'append', ...{ ignorable: true } } as unknown as { surfaceOp: 'append' },
    )).toThrow(/cannot be marked ignorable/)
  })

  it('refuses a marker value other than true', () => {
    const session = Session.create(SessionId('note-false-marker'))
    conversation(session)
    expect(() => session.append(
      'reaction/note',
      { targetSeq: 1, emoji: '👍', actor: 'owen', action: 'added' },
      { ...{ ignorable: false } } as unknown as { ignorable: true },
    )).toThrow(/invalid ignorable marker/)
  })
})

describe('reaction/note model projection', () => {
  it('reaches deriveMessages at its own log position, naming the reaction and its target', () => {
    const session = Session.create(SessionId('note-projection'))
    conversation(session)
    const surfaceBefore = [...session.deriveMessages()]
    const noteSeq = note(session, 1)
    // A later message is what used to be impossible to get right: the note is
    // pinned to the note's own seq, so it lands BEFORE this prompt, not after
    // it at the tail of every remaining request.
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'and the mower' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const derived = session.deriveMessages()

    // The turn's own content is unchanged and still first, one note was
    // inserted, and the newer prompt follows the note.
    expect(derived.slice(0, surfaceBefore.length)).toEqual(surfaceBefore)
    expect(derived).toHaveLength(surfaceBefore.length + 2)
    expect(textOf(derived.at(-1)!)).toBe('and the mower')
    const projected = derived[surfaceBefore.length]!
    expect(projected.role).toBe('user')
    expect(projected.source).toEqual({ kind: 'plugin', plugin: 'react-note' })
    expect(textOf(projected)).toBe('owen reacted 👍 to the message at seq 1.')
    // Deterministic id: the fold re-runs on replay, resume and compaction, so
    // the identity must come from the log (the note's seq), never from a clock
    // or a random uuid.
    expect(projected.id).toBe(`reaction-note-${noteSeq}`)
    expect(Object.isFrozen(projected)).toBe(true)
  })

  it('projects each action as its own line, in log order among the surface messages', () => {
    const session = Session.create(SessionId('note-actions'))
    conversation(session)
    // turn/end is seq 4, so these notes are seqs 5 and 6 and the later prompt
    // is seq 7: the notes sort between the first turn's tool result and it.
    session.append('reaction/note', { targetSeq: 2, emoji: '🎉', actor: 'hannah', action: 'removed' }, { ignorable: true })
    session.append('reaction/note', { targetSeq: 2, emoji: '😀', actor: 'quinn', action: 'changed' }, { ignorable: true })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'and the mower' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(session.deriveMessages().map(lineOf)).toEqual([
      'what is in the shed',
      'checking',
      'a rake and a mower',
      'hannah removed their 🎉 reaction from the message at seq 2.',
      'quinn changed their reaction on the message at seq 2 to 😀.',
      'and the mower',
    ])
  })

  it('keeps the note out of the ordered surface, so no transcript node can claim it', () => {
    const session = Session.create(SessionId('note-off-surface'))
    conversation(session)
    const before = foldSurface(session.events)
    const noteSeq = note(session, 1)
    const after = foldSurface(session.events)

    expect(after.nodes).toEqual(before.nodes)
    expect(after.replacements).toEqual(before.replacements)
    expect(after.nodes).not.toContain(noteSeq)
    expect(session.surface.nodes).not.toContain(noteSeq)
    // A surface event is what the client node registry matches on; a note is
    // not one, so the fallback node cannot render it either.
    expect(isSurfaceEvent(session.events[noteSeq]!)).toBe(false)
    expect(isModelNoteEvent(session.events[noteSeq]!)).toBe(true)
  })

  it('keeps the note text out of every compaction span, and out of summarisation input', () => {
    const session = Session.create(SessionId('note-compaction'))
    conversation(session)
    note(session, 1)
    session.append('assistant/chunk', { turn: 2, step: 1, chunk: { type: 'text-delta', index: 0, text: 'ok' } })

    // The span builder of `compaction-basic` folds exactly this surface list
    // and maps `deriveEventMessage` over it. A note is never in it, so a
    // summariser can neither read the reaction nor carry it into the durable
    // checkpoint — and a later catch-all that folded log-only events into
    // summarisation would have to change this fold first.
    const span = foldSurface(session.events).nodes
    const summarised = span.map(seq => deriveEventMessage(session.events[seq]!))
    expect(summarised.map(message => message === null ? '' : textOf(message)).join('\n'))
      .not.toMatch(/reacted|reaction/)
  })

  it('drops the note once a compaction-shaped replacement shadows its target', () => {
    const session = Session.create(SessionId('note-after-replace'))
    conversation(session)
    const noteSeq = note(session, 1)
    const before = session.deriveMessages()
    // Sanity: while seq 1 is still conversational context, the note is derived.
    expect(before.map(message => message.id)).toContain(`reaction-note-${noteSeq}`)

    // Owen's rule: a reaction lives exactly as long as the message it reacts
    // to. This replacement shadows [1,2,3] — the note's target seq 1 included —
    // so the note is NOT derived any more. Being log-only, it stays in the
    // durable log ('reaction/note' is still appended), but the model stops
    // hearing about a message it can no longer see.
    const summary = createUserMessage({
      content: [{ type: 'text', text: '<compacted-summary>condensed</compacted-summary>' }],
      source: { kind: 'plugin', plugin: 'compaction' },
    })
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', start: 1, end: 3 },
      sourceEventSeqs: [1, 2, 3],
    })
    const after = session.deriveMessages()

    expect(after).toHaveLength(1)
    expect(textOf(after[0]!)).toContain('<compacted-summary>')
    expect(after.map(message => message.id)).not.toContain(`reaction-note-${noteSeq}`)
    expect(after.map(textOf).join('\n')).not.toMatch(/reacted|reaction/)
    // The log itself is untouched: drop is a derivation decision, not a delete.
    expect(session.events[noteSeq]?.type).toBe('reaction/note')
  })

  it('keeps the note when a replacement leaves its target on the surface', () => {
    const session = Session.create(SessionId('note-live-target'))
    conversation(session)
    // The note reacts to the tool result (seq 3), not to the compacted range.
    const noteSeq = note(session, 3)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'and the mower' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    // Replace [1,2] only: seq 3 survives, so the note must survive with it.
    const summary = createUserMessage({
      content: [{ type: 'text', text: '<compacted-summary>condensed</compacted-summary>' }],
      source: { kind: 'plugin', plugin: 'compaction' },
    })
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', start: 1, end: 2 },
      sourceEventSeqs: [1, 2],
    })
    const after = session.deriveMessages()

    // Surface order is now [replacement, tool result, later prompt]. The note's
    // seq (5) precedes the replacement copy's seq, so it is derived immediately
    // before it — interleaved by the log, never pinned to the tail.
    expect(after.map(lineOf)).toEqual([
      'owen reacted 👍 to the message at seq 3.',
      '<compacted-summary>condensed</compacted-summary>',
      'a rake and a mower',
      'and the mower',
    ])
    expect(after[0]!.id).toBe(`reaction-note-${noteSeq}`)
    // Purity: the same log replayed from scratch derives the same array.
    expect(Session.create(SessionId('note-live-target-replay'), [...session.events]).deriveMessages())
      .toEqual(after)
  })

  it('is stable across repeated derivation and a from-scratch replay', () => {
    const session = Session.create(SessionId('note-stable'))
    conversation(session)
    note(session, 1)
    note(session, 2, '🎉')
    const first = session.deriveMessages()
    expect(session.deriveMessages()).toEqual(first)
    const replayed = Session.create(SessionId('note-stable-replay'), [...session.events]).deriveMessages()
    expect(replayed).toEqual(first)
  })

  it('derives the same array before and after a replay of a compacted log', () => {
    const session = Session.create(SessionId('note-compacted-replay'))
    conversation(session)
    note(session, 2)
    note(session, 3, '🎉')
    const summary = createUserMessage({
      content: [{ type: 'text', text: '<compacted-summary>condensed</compacted-summary>' }],
      source: { kind: 'plugin', plugin: 'compaction' },
    })
    // Shadows seq 2 (dropping its note) but not seq 3 (keeping its note).
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', start: 2, end: 2 },
      sourceEventSeqs: [2],
    })
    const live = session.deriveMessages()
    expect(live.map(lineOf)).toEqual([
      'what is in the shed',
      'owen reacted 🎉 to the message at seq 3.',
      '<compacted-summary>condensed</compacted-summary>',
      'a rake and a mower',
    ])
    expect(session.deriveMessages()).toEqual(live)
    expect(Session.create(SessionId('note-compacted-replay-2'), [...session.events]).deriveMessages())
      .toEqual(live)
  })
})
