/**
 * Reaction notes: a log-only, UI-only record of one human act.
 *
 * Five properties are pinned here because all five are defaults a later change
 * could silently reverse:
 *
 * 1. the envelope marker — `Session.append('reaction/note', …)` writes
 *    `ignorable: true`, so a reader that does not know the kind skips it
 *    instead of refusing the whole log;
 * 2. the prompt-cache property — appending a reaction to a message several
 *    turns back leaves `Session.deriveMessages()` ELEMENT-FOR-ELEMENT IDENTICAL.
 *    That array is exactly what the agent loop hands the provider, so a note
 *    that never enters it can never insert text mid-history and invalidate a
 *    cached prefix. This is asserted, never assumed, and it holds at any log
 *    position because a note is outside the derivation entirely;
 * 3. the free exclusions — the transcript fold (`foldSurface`, which the
 *    browser registry and the compaction span builder both fold) contains no
 *    note, and neither does any per-event projection
 *    (`deriveEventMessage(note)` is null), so nothing renders it in the
 *    transcript, summarises it, or prices it as context;
 * 4. the UI projection — `Session.reactionNotes()` is where a reaction lives,
 *    keyed by the message it targets, with the lifetime rule attached: a note
 *    is live exactly while its `targetSeq` is still a current surface node, so
 *    a compaction `replace` that shadows the message takes the reaction with
 *    it (Owen's rule), while the durable log keeps the record either way;
 * 5. the cache contract — the derivation stays incremental for appends, and a
 *    from-scratch replay derives exactly what the live session derived.
 */

import { describe, expect, it } from 'vitest'
import { createMessage, createToolResultMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, foldSurface, isReactionNoteEvent, isSurfaceEvent } from '@deepseek-ai/dsh-session'
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

/** Close one more turn so the log carries more than one turn's worth of history. */
function secondTurn(session: Session, text: string): void {
  session.append('turn/start', { turn: 2 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
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

/** A compaction-shaped replacement of one surface range. */
function compact(session: Session, start: number, end: number): void {
  const sourceEventSeqs: number[] = []
  for (let seq = start; seq <= end; seq++) sourceEventSeqs.push(seq)
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '<compacted-summary>condensed</compacted-summary>' }],
    source: { kind: 'plugin', plugin: 'compaction' },
  }), { surfaceOp: { op: 'replace', start, end }, sourceEventSeqs })
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

describe('reaction/note never enters the model-bound history', () => {
  it('leaves deriveMessages element-for-element identical when a message several turns back is reacted to', () => {
    const session = Session.create(SessionId('note-identity'))
    conversation(session)
    secondTurn(session, 'and the mower')

    // The prompt-cache property, asserted rather than assumed: this is the exact
    // array `packages/core/agent-loop` hands the provider as the conversation.
    const before = session.deriveMessages()
    expect(before.map(lineOf)).toEqual(['what is in the shed', 'checking', 'a rake and a mower', 'and the mower'])

    note(session, 1)
    const after = session.deriveMessages()
    expect(after).toEqual(before)
    expect(after).toHaveLength(before.length)
    // Identity, not merely value equality: no element was re-projected, shifted
    // or replaced, so a provider that caches by prefix sees the same bytes.
    after.forEach((message, index) => { expect(message).toBe(before[index]) })
    expect(JSON.stringify(after)).not.toMatch(/reacted|reaction/)
  })

  it('leaves the cached array identical at the next turn boundary, note in the middle of the log', () => {
    const session = Session.create(SessionId('note-identity-next-turn'))
    conversation(session)
    const before = session.deriveMessages()
    note(session, 2)
    note(session, 1, '🎉')
    // The note is now NOT the last log entry: a later turn follows it, which is
    // exactly the case that used to reorder history under the model.
    session.append('turn/start', { turn: 2 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'and the mower' }], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const promptOnly = session.deriveMessages()
    expect(promptOnly.slice(0, before.length)).toEqual(before)
    expect(promptOnly).toHaveLength(before.length + 1)
    expect(lineOf(promptOnly.at(-1)!)).toBe('and the mower')
    session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })

    const after = session.deriveMessages()
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.map(lineOf)).toEqual(['what is in the shed', 'checking', 'a rake and a mower', 'and the mower'])
    // A from-scratch replay of the same log derives the same array, notes and
    // all — the property is a function of the log, not of the live cache.
    expect(Session.create(SessionId('note-identity-next-turn-replay'), [...session.events]).deriveMessages())
      .toEqual(after)
  })

  it('projects a note to no message at all, so no fold can carry one', () => {
    const session = Session.create(SessionId('note-projection-null'))
    conversation(session)
    const noteSeq = note(session, 1)

    // The per-event projection is THE rule every reconstructor folds — this
    // session's derivation, a compaction span, a token meter, an external
    // replay. A null here is what makes "no reaction in a request" structural
    // rather than a promise about one caller.
    expect(deriveEventMessage(session.events[noteSeq]!)).toBeNull()
    expect(session.deriveEventMessage(session.events[noteSeq]!)).toBeNull()
    expect(session.deriveMessages().map(message => message.id)).not.toContain(`reaction-note-${noteSeq}`)
    expect(session.deriveMessages().some(message => message.source.kind === 'plugin')).toBe(false)
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
    expect(isReactionNoteEvent(session.events[noteSeq]!)).toBe(true)
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
    expect(summarised.map(message => message === null ? '' : lineOf(message)).join('\n'))
      .not.toMatch(/reacted|reaction/)
  })
})

describe('reaction/note UI projection: Session.reactionNotes()', () => {
  it('reports the reaction on the message it targets, not the message that came after it', () => {
    const session = Session.create(SessionId('note-ui-projection'))
    conversation(session)
    const noteSeq = note(session, 2, '👎')
    secondTurn(session, 'and the mower')

    const notes = session.reactionNotes()
    expect(notes).toHaveLength(1)
    expect(notes[0]!.seq).toBe(noteSeq)
    expect(notes[0]!.data).toEqual({ targetSeq: 2, emoji: '👎', actor: 'owen', action: 'added' })
    // Frozen and shared: a UI cannot mutate durable history through it.
    expect(Object.isFrozen(notes)).toBe(true)
    expect(Object.isFrozen(notes[0])).toBe(true)
    expect(session.reactionNotes()).toBe(notes)
  })

  it('reports every live note in log order, and drops the ones already shadowed', () => {
    const session = Session.create(SessionId('note-ui-order'))
    conversation(session)
    const first = note(session, 1, '👍')
    const second = note(session, 3, '🎉')
    expect(session.reactionNotes().map(event => event.seq)).toEqual([first, second])

    // Shadowing seq 1 leaves seq 3 on the surface, so exactly one note lapses.
    compact(session, 1, 1)
    expect(session.reactionNotes().map(event => event.seq)).toEqual([second])
    // The log keeps both: a lapse is a projection decision, not a delete.
    expect(session.events[first]?.type).toBe('reaction/note')
  })

  it('drops the note once a compaction-shaped replacement shadows its target', () => {
    const session = Session.create(SessionId('note-after-replace'))
    conversation(session)
    const noteSeq = note(session, 1)
    expect(session.reactionNotes().map(event => event.seq)).toEqual([noteSeq])
    const derivedBefore = session.deriveMessages()

    // Owen's rule: a reaction lives exactly as long as the message it reacts
    // to. This replacement shadows [1,2,3] — the note's target seq 1 included —
    // so the UI projection stops showing it, and the model never hears about it
    // either (the derived array was note-free before AND after: only the
    // replacement itself changed it).
    compact(session, 1, 3)
    expect(session.reactionNotes()).toHaveLength(0)
    const after = session.deriveMessages()
    expect(after).toHaveLength(1)
    expect(lineOf(after[0]!)).toContain('<compacted-summary>')
    expect(derivedBefore.map(lineOf)).toEqual(['what is in the shed', 'checking', 'a rake and a mower'])
    expect(after.map(lineOf).join('\n')).not.toMatch(/reacted|reaction/)
    // The log itself is untouched: drop is a projection decision, not a delete.
    expect(session.events[noteSeq]?.type).toBe('reaction/note')
  })

  it('keeps the note when a replacement leaves its target on the surface', () => {
    const session = Session.create(SessionId('note-live-target'))
    conversation(session)
    // The note reacts to the tool result (seq 3), not to the compacted range.
    const noteSeq = note(session, 3)
    secondTurn(session, 'and the mower')

    compact(session, 1, 2)

    // Seq 3 survives the replacement, so the reaction survives with it.
    expect(session.reactionNotes().map(event => event.seq)).toEqual([noteSeq])
    // Purity: the same log replayed from scratch projects the same notes, and
    // derives the same note-free history.
    const replayed = Session.create(SessionId('note-live-target-replay'), [...session.events])
    expect(replayed.reactionNotes().map(event => event.seq)).toEqual([noteSeq])
    expect(replayed.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('is stable across repeated derivation and a from-scratch replay', () => {
    const session = Session.create(SessionId('note-stable'))
    conversation(session)
    note(session, 1)
    note(session, 2, '🎉')
    const first = session.deriveMessages()
    const notes = session.reactionNotes()
    expect(session.deriveMessages()).toEqual(first)
    expect(session.reactionNotes()).toEqual(notes)

    const replayed = Session.create(SessionId('note-stable-replay'), [...session.events])
    expect(replayed.deriveMessages()).toEqual(first)
    expect(replayed.reactionNotes()).toEqual(notes)
  })

  it('derives and projects identically across a replay of a compacted log', () => {
    const session = Session.create(SessionId('note-compacted-replay'))
    conversation(session)
    note(session, 2)
    note(session, 3, '🎉')
    // Shadows seq 2 (dropping its note) but not seq 3 (keeping its note).
    compact(session, 2, 2)

    const live = session.deriveMessages()
    expect(live.map(lineOf)).toEqual([
      'what is in the shed',
      '<compacted-summary>condensed</compacted-summary>',
      'a rake and a mower',
    ])
    const liveNotes = session.reactionNotes()
    expect(liveNotes.map(event => event.data.targetSeq)).toEqual([3])
    expect(session.deriveMessages()).toEqual(live)

    const replayed = Session.create(SessionId('note-compacted-replay-2'), [...session.events])
    expect(replayed.deriveMessages()).toEqual(live)
    expect(replayed.reactionNotes().map(event => event.seq)).toEqual(liveNotes.map(event => event.seq))
  })
})
