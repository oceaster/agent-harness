/**
 * The restart case for a log-only reaction note — the brick the spike measured.
 *
 * A reaction note is a kind this build knows. A build that predates the kind
 * (the deployed harness during a rollout) does not, and the persistence read
 * path refuses an unrecognized type unless the event carries the envelope's
 * `ignorable: true` marker. Nothing in the repo could write that marker before
 * this change, so appending a note used to make the conversation unreadable to
 * ANY reader, including the one that wrote it.
 *
 * These tests use the web profile's own session store (the jsonl backend) and
 * a **new Context on the same root** for the restart: what an ordinary process
 * restart does, without a second process.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'

const roots: string[] = []

/** One isolated persistence root, removed after the file finishes. */
async function freshRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-reaction-note-'))
  roots.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** Mount the store plus the jsonl backend on `root` and announce a session. */
async function boot(
  root: string,
  id: SessionId,
  compression: 'none' | 'zstd',
): Promise<{ ctx: Context; session: Session }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(JsonlSessionPersistence, { root, compression })
  return { ctx, session: ctx.sessions.create(id, { meta: { cwd: '/work' } }) }
}

/** The one stored artifact under `root` whose name starts with `session`. */
async function storedArtifact(root: string): Promise<string> {
  const found = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.startsWith('session'))
  expect(found).toHaveLength(1)
  return join(found[0]!.parentPath, found[0]!.name)
}

/** One ordinary turn: prompt, reply, closed turn. */
function turn(session: Session): void {
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'the shed door is stuck' }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'try the handle' }],
      source: { kind: 'model', ...{ provider: 'mock', model: 'mock' } },
    }),
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

/** Record one reaction note the way the RPC does. */
function react(session: Session): number {
  return session.append('reaction/note', {
    targetSeq: 1, emoji: '👍', actor: 'owen', action: 'added',
  }, { ignorable: true }).seq
}

describe('reaction/note survives a restart of the build that wrote it', () => {
  it('reopens the conversation with the note still in the log', async () => {
    const root = await freshRoot()
    const id = SessionId('restart-note')
    // The web profile's own compression, so the restart reads a compressed log.
    const first = await boot(root, id, 'zstd')
    turn(first.session)
    const noteSeq = react(first.session)
    const derivedBefore = first.session.deriveMessages()
    await first.ctx.sessions.flush(first.session)
    await first.ctx.fiber.dispose()

    // A fresh process on the same root: this is the load path `session.history`
    // and cold resume take.
    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    const inspected = await second.sessionPersistence.load(id)
    expect(inspected.events.map(event => event.type)).toContain('reaction/note')
    const note = inspected.events[noteSeq]!
    expect(note.ignorable).toBe(true)
    expect(note.data).toEqual({ targetSeq: 1, emoji: '👍', actor: 'owen', action: 'added' })

    // The conversation opens: a live session built from the stored log derives
    // the same history, note included, and the note is not in its surface.
    const reopened = second.sessions.create(id, { seed: [...inspected.events], meta: inspected.meta })
    expect(reopened.deriveMessages()).toEqual(derivedBefore)
    expect(reopened.surface.nodes).not.toContain(noteSeq)
    await second.fiber.dispose()
  })

  it('records the marker in the durable artifact, not only in memory', async () => {
    const root = await freshRoot()
    const first = await boot(root, SessionId('restart-bytes'), 'none')
    turn(first.session)
    react(first.session)
    await first.ctx.sessions.flush(first.session)
    await first.ctx.fiber.dispose()

    const bytes = await readFile(await storedArtifact(root), 'utf8')
    const lines = bytes.trimEnd().split('\n').slice(1).map(line => JSON.parse(line) as Record<string, unknown>)
    const stored = lines.find(line => line['type'] === 'reaction/note')
    expect(stored).toBeDefined()
    expect(stored).toHaveProperty('ignorable', true)
  })
})

describe('the brick the marker prevents', () => {
  /**
   * Write one note through the real append path, then restart on the same root
   * after `update` edited the stored line. Returns the reload outcome.
   */
  async function reloadAfter(id: SessionId, update: (event: Record<string, unknown>) => void): Promise<{
    failure: Error | undefined
    events: readonly SessionEvent[]
  }> {
    const root = await freshRoot()
    const first = await boot(root, id, 'none')
    turn(first.session)
    react(first.session)
    await first.ctx.sessions.flush(first.session)
    await first.ctx.fiber.dispose()

    const path = await storedArtifact(root)
    const lines = (await readFile(path, 'utf8')).trimEnd().split('\n')
    const index = lines.findIndex(line => line.includes('"reaction/note"'))
    expect(index).toBeGreaterThan(0)
    const event = JSON.parse(lines[index]!) as Record<string, unknown>
    update(event)
    lines[index] = JSON.stringify(event)
    await writeFile(path, `${lines.join('\n')}\n`)

    const second = new Context()
    await second.plugin(SessionStore)
    await second.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    try {
      const inspected = await second.sessionPersistence.load(id)
      return { failure: undefined, events: inspected.events }
    } catch (error: unknown) {
      return { failure: error as Error, events: [] }
    } finally {
      await second.fiber.dispose()
    }
  }

  it('refuses an unrecognized note kind written WITHOUT the marker', async () => {
    // An older build — one that predates `reaction/note` — sees an unknown type.
    // This is exactly the spike's measured brick: the log becomes unreadable.
    const outcome = await reloadAfter(SessionId('brick-no-marker'), (event) => {
      event['type'] = 'reaction/note-next'
      delete event['ignorable']
    })
    expect(outcome.failure?.name).toBe('SessionFormatUnsupportedError')
    expect(outcome.failure?.message).toMatch(/event type "reaction\/note-next".*not marked ignorable/)
  })

  it('accepts the same unknown kind once the marker is present', async () => {
    // The marker is the whole difference: a reader that does not know the kind
    // skips that one event instead of refusing the conversation.
    const outcome = await reloadAfter(SessionId('brick-with-marker'), (event) => {
      event['type'] = 'reaction/note-next'
    })
    expect(outcome.failure).toBeUndefined()
    expect(outcome.events.map(event => event.type)).toContain('reaction/note-next')
    expect(outcome.events.map(event => event.type)).toContain('turn/end')
  })
})
