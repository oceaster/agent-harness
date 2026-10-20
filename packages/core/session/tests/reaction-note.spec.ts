/**
 * Reaction notes: a log-only event kind that reaches the model and nothing else.
 *
 * Three properties are pinned here because all three are defaults a later
 * change could silently reverse:
 *
 * 1. the envelope marker — `Session.append('reaction/note', …)` writes
 *    `ignorable: true`, so a reader that does not know the kind skips it
 *    instead of refusing the whole log;
 * 2. the model projection — the note appears in `deriveMessages()` after the
 *    surface segment, with a seq-derived id and a plugin source, while the
 *    ordered surface never sees it;
 * 3. the two free exclusions — the transcript fold (`foldSurface`, which the
 *    browser registry and the compaction span builder both fold) contains no
 *    note, so nothing renders it and nothing summarises it.
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
  it('reaches deriveMessages after the surface, naming the reaction and its target', () => {
    const session = Session.create(SessionId('note-projection'))
    conversation(session)
    const surfaceBefore = [...session.deriveMessages()]
    const noteSeq = note(session, 1)
    const derived = session.deriveMessages()

    // The turn's own content is unchanged, and the note is appended after it.
    expect(derived.slice(0, surfaceBefore.length)).toEqual(surfaceBefore)
    expect(derived.length).toBe(surfaceBefore.length + 1)
    const projected = derived.at(-1)!
    expect(projected.role).toBe('user')
    expect(projected.source).toEqual({ kind: 'plugin', plugin: 'react-note' })
    expect(textOf(projected)).toBe('owen reacted 👍 to the message at seq 1.')
    // Deterministic id: the fold re-runs on replay, resume and compaction, so
    // the identity must come from the log (the note's seq), never from a clock
    // or a random uuid.
    expect(projected.id).toBe(`reaction-note-${noteSeq}`)
    expect(Object.isFrozen(projected)).toBe(true)
  })

  it('projects each action as its own line', () => {
    const session = Session.create(SessionId('note-actions'))
    conversation(session)
    session.append('reaction/note', { targetSeq: 2, emoji: '🎉', actor: 'hannah', action: 'removed' }, { ignorable: true })
    session.append('reaction/note', { targetSeq: 2, emoji: '😀', actor: 'quinn', action: 'changed' }, { ignorable: true })
    const notes = session.deriveMessages().slice(3).map(textOf)
    expect(notes).toEqual([
      'hannah removed their 🎉 reaction from the message at seq 2.',
      'quinn changed their reaction on the message at seq 2 to 😀.',
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

  it('survives a compaction-shaped surface replacement with its order and identity intact', () => {
    const session = Session.create(SessionId('note-after-replace'))
    conversation(session)
    const noteSeq = note(session, 1)
    const before = session.deriveMessages()

    // A replacement rebuilds the derived cache from the log (generation bump):
    // the note still follows the surface, and still carries its seq-derived id.
    const summary = createUserMessage({
      content: [{ type: 'text', text: '<compacted-summary>condensed</compacted-summary>' }],
      source: { kind: 'plugin', plugin: 'compaction' },
    })
    session.append('user/message', summary, {
      surfaceOp: { op: 'replace', start: 1, end: 3 },
      sourceEventSeqs: [1, 2, 3],
    })
    const after = session.deriveMessages()

    expect(after).toHaveLength(2)
    expect(textOf(after[0]!)).toContain('<compacted-summary>')
    expect(textOf(after[1]!)).toBe('owen reacted 👍 to the message at seq 1.')
    expect(after[1]!.id).toBe(`reaction-note-${noteSeq}`)
    expect(before.at(-1)!.id).toBe(after.at(-1)!.id)
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
})
