/**
 * `session.react`: the append-only wire for a reaction note.
 *
 * The RPC is the contract the reaction UI ticket builds against, so this file
 * pins its shape: the payload, the return, the two refusals, and — the point of
 * the whole ticket — that the call appends ONE log-only event carrying the
 * envelope's `ignorable` marker and starts nothing else. A turn, a model call, a
 * title, a queue entry, a goal record or a derived-surface change would each
 * break one of those assertions.
 *
 * Cold-session resolution (`agentFor`) is every unary's shared path and
 * `api-proxy-cold.spec.ts` owns that evidence, `session-not-found` included.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import { sessionReactRequestSchema, sessionReactValueSchema } from '@deepseek-ai/dsh-host-apiproxy/api/sessions.schema'

const sid = (id: string): SessionId => id as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`react-${String(nextRpc++)}`), payload }
}

/** A host with a store, an agent registry, and an attached idle agent. */
async function composed(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(UserQuestionService)
  ctx.agents.setFactory({
    createAgent: () => Promise.reject(new Error('create must not run: every source is attached')),
    resume: () => Promise.reject(new Error('resume must not run: every source is attached')),
  })
  return ctx
}

/** Register one live agent whose log holds one complete turn plus a tool result. */
function liveAgent(ctx: Context, id: string): Session {
  const session = ctx.sessions.create(sid(id), { meta: { cwd: '/proj' } })
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'is the shed locked' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'checking' }, { type: 'tool-call', id: CallId('c1'), name: 'ls', arguments: '{}' }],
      source: { kind: 'model', ...{ provider: 'p', model: 'm' } },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId: CallId('c1'),
      content: [{ type: 'text', text: 'locked' }],
      isError: false,
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  return session
}

const api = (ctx: Context) => createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })

/** Event-type counts, so a diff of two snapshots shows every other appending path. */
function counts(session: Session): Record<string, number> {
  const tally: Record<string, number> = {}
  for (const event of session.events) tally[event.type] = (tally[event.type] ?? 0) + 1
  return tally
}

describe('session.react', () => {
  it('appends one log-only note with the ignorable marker and returns its seq', async () => {
    const ctx = await composed()
    const session = liveAgent(ctx, 'session-react')
    const before = counts(session)
    const surfaceBefore = [...session.surface.nodes]
    const derivedBefore = session.deriveMessages()

    const response = await api(ctx).sessions.react(request({
      sessionId: session.id,
      targetSeq: 2,
      emoji: '👍',
      actor: 'owen',
    }))

    expect(response.result.ok).toBe(true)
    if (!response.result.ok) return
    const note = session.events[response.result.value.seq]
    expect(note?.type).toBe('reaction/note')
    expect(note?.ignorable).toBe(true)
    expect(note?.data).toEqual({ targetSeq: 2, emoji: '👍', actor: 'owen', action: 'added' })

    // Exactly one appended event, and no turn machinery moved with it.
    expect(counts(session)).toEqual({ ...before, 'reaction/note': 1 })
    expect(session.events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(session.events.some(event => event.type === 'session/title')).toBe(false)
    expect(session.events.some(event => event.type === 'goal/change')).toBe(false)
    expect(session.events.some(event => event.type.startsWith('llm/retry'))).toBe(false)

    // No transcript row (nothing joined the surface), no queue or steering
    // record, and the agent stays idle: this call does no work of its own.
    expect([...session.surface.nodes]).toEqual(surfaceBefore)
    expect(session.events.some(event => event.type === 'agent/inbox/spliced')).toBe(false)
    expect(ctx.agents.get(session.id)?.status).toBe('idle')

    // The model does NOT see it. The derived history — the array the agent loop
    // hands the provider — is element-for-element what it was before the
    // reaction, so a note can never invalidate a cached prefix.
    const derivedAfter = session.deriveMessages()
    expect(derivedAfter).toEqual(derivedBefore)
    expect(derivedAfter).toHaveLength(derivedBefore.length)
    derivedAfter.forEach((message, index) => { expect(message).toBe(derivedBefore[index]) })
    // The reaction is still recorded for the human, and this is where the UI
    // reads it: the note on the message it targets.
    expect(session.reactionNotes().map(event => event.seq)).toEqual([response.result.value.seq])
  })

  it('defaults action to added and actor to user, and accepts the other two actions', async () => {
    const ctx = await composed()
    const session = liveAgent(ctx, 'session-react-defaults')
    const host = api(ctx)
    const bare = await host.sessions.react(request({ sessionId: session.id, targetSeq: 1, emoji: '🎉' }))
    expect(bare.result.ok).toBe(true)
    if (!bare.result.ok) return
    expect(session.events[bare.result.value.seq]?.data).toEqual({
      targetSeq: 1, emoji: '🎉', actor: 'user', action: 'added',
    })

    const removed = await host.sessions.react(request({
      sessionId: session.id, targetSeq: 1, emoji: '🎉', action: 'removed', actor: 'hannah',
    }))
    expect(removed.result.ok).toBe(true)
    if (!removed.result.ok) return
    expect(session.events[removed.result.value.seq]?.data).toMatchObject({ action: 'removed', actor: 'hannah' })
    // Both notes stay in the log and out of the model-bound history: the last
    // two appends changed nothing the provider would be sent.
    expect(session.deriveMessages().map(message => message.role)).toEqual(['user', 'assistant', 'user'])
    expect(session.reactionNotes().map(event => event.data.action)).toEqual(['added', 'removed'])
  })

  it('refuses a target that is not a message, appending nothing', async () => {
    const ctx = await composed()
    const session = liveAgent(ctx, 'session-react-toolresult')
    const host = api(ctx)
    const before = session.events.length
    const toolResultSeq = session.events.findIndex(event => event.type === 'tool/result')
    expect(toolResultSeq).toBeGreaterThan(0)
    // A tool result IS an append-origin message, so it is a legal target.
    const accepted = await host.sessions.react(request({
      sessionId: session.id, targetSeq: toolResultSeq, emoji: '👍',
    }))
    expect(accepted.result.ok).toBe(true)

    // A boundary marker (`turn/start` at 0, `turn/end` at 4), a past-the-end
    // seq, and the note just appended at 5 are all invalid targets.
    for (const targetSeq of [0, 4, session.events.length, session.events.length + 5]) {
      const refused = await host.sessions.react(request({
        sessionId: session.id, targetSeq, emoji: '👍',
      }))
      expect(refused.result.ok).toBe(false)
      if (refused.result.ok) return
      expect(refused.result.error.code).toBe('target-not-valid')
      expect(refused.result.error.details).toEqual({ sessionId: session.id, targetSeq })
    }
    // Only the one accepted note landed.
    expect(session.events.length).toBe(before + 1)
    expect(session.events.filter(event => event.type === 'reaction/note')).toHaveLength(1)
  })

  it('round-trips its payload and value through the wire schemas', () => {
    expect(sessionReactRequestSchema.parse({ sessionId: 's1', targetSeq: 4, emoji: '👍' }))
      .toEqual({ sessionId: 's1', targetSeq: 4, emoji: '👍' })
    expect(sessionReactRequestSchema.parse({
      sessionId: 's1', targetSeq: 4, emoji: '🎉', action: 'changed', actor: 'quinn',
    })).toMatchObject({ action: 'changed', actor: 'quinn' })
    expect(sessionReactValueSchema.parse({ seq: 12 })).toEqual({ seq: 12 })

    // Refusals at the wire: an empty glyph is not a reaction, an unbounded one
    // is prose in a field the model is told is a glyph, and a negative seq
    // names no log entry.
    expect(sessionReactRequestSchema.safeParse({ sessionId: 's1', targetSeq: 4, emoji: '  ' }).success).toBe(false)
    expect(sessionReactRequestSchema.safeParse({ sessionId: 's1', targetSeq: 4, emoji: 'x'.repeat(33) }).success).toBe(false)
    expect(sessionReactRequestSchema.safeParse({ sessionId: 's1', targetSeq: -1, emoji: '👍' }).success).toBe(false)
    expect(sessionReactRequestSchema.safeParse({ sessionId: 's1', targetSeq: 4, emoji: '👍', action: 'toggled' }).success).toBe(false)
    expect(sessionReactRequestSchema.safeParse({ sessionId: '', targetSeq: 4, emoji: '👍' }).success).toBe(false)
  })
})
