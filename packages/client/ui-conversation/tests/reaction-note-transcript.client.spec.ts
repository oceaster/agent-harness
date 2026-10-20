/**
 * The reaction note must stay invisible in the browser transcript — and that
 * invisibility is a property of the node registry's default, not a statement
 * anyone wrote down.
 *
 * The registry matches surface events; a log-only kind is dropped because no
 * Definition claims it. Two things could silently reverse that:
 *
 * - a new catch-all Definition (an "anything else" node) matching every event,
 *   not just append-surface ones — the first test fails then;
 * - `reaction/note` joining the surface-eligible union, which would route it
 *   into the existing `unknown-surface` fallback row — the surface tests in
 *   `@deepseek-ai/dsh-session` fail then, and the transcript comparison here
 *   fails too.
 *
 * So: the chat snapshot of a conversation is byte-identical before and after a
 * note, and no registered Definition matches the note at all.
 */

import { describe, expect, it } from 'vitest'
import type {
  ChatConversationViewNode, ChatSnapshot, ConversationEventInput,
  ConversationNodeDefinition, ConversationViewDefinition,
} from '@deepseek-ai/dsh-client-runtime/client'
import { ConversationNodeAssembler } from '@deepseek-ai/dsh-client-runtime/client'
import { assistantDefinition } from '../src/client/conversation-nodes/assistant.ts'
import { chatViewDefinition } from '../src/client/conversation-nodes/chat-snapshot-builder.ts'
import { commandDefinition } from '../src/client/conversation-nodes/command.ts'
import { compactionDefinition } from '../src/client/conversation-nodes/compaction.ts'
import { unknownFallbackDefinition } from '../src/client/conversation-nodes/fallback.ts'
import { nextStepInboxDefinition, nextTurnInboxDefinition } from '../src/client/conversation-nodes/inbox.ts'
import { messageDefinition } from '../src/client/conversation-nodes/message.ts'
import { retryDefinition } from '../src/client/conversation-nodes/retry.ts'
import { toolDefinition } from '../src/client/conversation-nodes/tool.ts'
import { turnErrorDefinition } from '../src/client/conversation-nodes/turn-error.ts'
import { turnMaxTokensDefinition } from '../src/client/conversation-nodes/turn-max-tokens.ts'
import { turnTailDefinition } from '../src/client/conversation-nodes/turn-tail.ts'

/** Every node Definition the shipped registry installs. */
const DEFINITIONS: readonly ConversationNodeDefinition[] = [
  nextTurnInboxDefinition,
  nextStepInboxDefinition,
  messageDefinition,
  assistantDefinition,
  toolDefinition,
  commandDefinition,
  compactionDefinition,
  retryDefinition,
  turnErrorDefinition,
  turnMaxTokensDefinition,
  turnTailDefinition,
]

class TestEventDefinitions {
  entries(): readonly ConversationNodeDefinition[] {
    return DEFINITIONS
  }

  fallbackEntry(): ConversationNodeDefinition {
    return unknownFallbackDefinition
  }
}

class TestViewDefinitions {
  entries(): readonly ConversationViewDefinition[] {
    return [chatViewDefinition]
  }
}

/** One conversation event at `seq`. */
function at(seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): ConversationEventInput {
  return {
    event: {
      seq,
      time: 1_700_000_000_000 + seq,
      type,
      data,
      ...extra,
    } as unknown as ConversationEventInput['event'],
    view: undefined,
  }
}

/** The same one-turn conversation, with or without a trailing reaction note. */
function conversation(withNote: boolean): ConversationEventInput[] {
  const events = [
    at(0, 'turn/start', { turn: 1 }),
    at(1, 'user/message', {
      id: 'user-1',
      role: 'user',
      content: [{ type: 'text', text: 'the shed door is stuck' }],
      source: { kind: 'user' },
    }, { surfaceOp: 'append' }),
    at(2, 'assistant/message', {
      turn: 1,
      step: 1,
      message: {
        id: 'assistant-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'try the handle' }],
        source: { kind: 'model', provider: 'fake', model: 'fake' },
      },
    }, { surfaceOp: 'append' }),
    at(3, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  if (!withNote) return events
  events.push(at(4, 'reaction/note', {
    targetSeq: 1, emoji: '👍', actor: 'owen', action: 'added',
  }, { ignorable: true }))
  return events
}

/** Build an assembler over one event window. */
function assembler(entries: readonly ConversationEventInput[]): ConversationNodeAssembler {
  const value = new ConversationNodeAssembler(new TestEventDefinitions(), new TestViewDefinitions())
  value.replaceWindow(entries, false)
  value.flush()
  return value
}

/** The assembled chat snapshot. */
function chat(value: ConversationNodeAssembler): ChatSnapshot {
  const current = value.snapshot('chat') as ChatSnapshot | undefined
  if (current === undefined) throw new Error('chat view was not registered')
  return current
}

/** A stable, order-insensitive-free rendering of every painted node. */
function painted(snapshot: ChatSnapshot): unknown[] {
  const nodes: ChatConversationViewNode[] = [...snapshot.nodes.values()]
  return nodes.map(node => ({ kind: node.kind, key: node.key, data: node.data }))
}

describe('a reaction note paints no transcript node', () => {
  it('leaves the chat snapshot identical', () => {
    const without = chat(assembler(conversation(false)))
    const withNote = chat(assembler(conversation(true)))

    expect(painted(withNote)).toEqual(painted(without))
    expect(withNote.order).toEqual(without.order)
    expect(JSON.stringify(painted(withNote))).toBe(JSON.stringify(painted(without)))
    // The note's seq appears in no node key, so nothing keyed by it was painted.
    expect(JSON.stringify(painted(withNote))).not.toContain('reaction/note')
  })

  it('is matched by no Definition, catch-all or fallback', () => {
    const note = at(4, 'reaction/note', {
      targetSeq: 1, emoji: '👍', actor: 'owen', action: 'added',
    }, { ignorable: true }).event
    expect(DEFINITIONS.filter(definition => definition.match(note) !== null).map(d => d.kind)).toEqual([])
    expect(unknownFallbackDefinition.match(note)).toBeNull()
  })

  it('still paints the conversation itself, so the comparison above is not vacuous', () => {
    const paintedWithout = painted(chat(assembler(conversation(false))))
    expect(paintedWithout.map(node => (node as { kind: string }).kind)).toContain('assistant-step')
    expect(JSON.stringify(paintedWithout)).toContain('the shed door is stuck')
  })
})
