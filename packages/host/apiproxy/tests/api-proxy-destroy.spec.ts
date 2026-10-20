/**
 * `session.destroy`: permanent, honest, single-session deletion.
 *
 * These tests run the real host spine — agent loop, JSONL session persistence
 * and the file-backed storage domains — inside a temporary home, because what
 * has to be proven is exactly what a fake would paper over: the log directory,
 * the projection checkpoint and the workspace registry are gone afterwards, and
 * a cold boot over the same home does not bring the id back.
 */

import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { Session, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionProjectionCache from '@deepseek-ai/dsh-session-projection-cache'
import Storage from '@deepseek-ai/dsh-storage'
import { apply as applyStorageDomain, Config as StorageDomainConfig, inject as storageDomainInject }
  from '@deepseek-ai/dsh-storage-domain'
import { apply as applyStorageJson, Config as StorageJsonConfig, inject as storageJsonInject }
  from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '../src/api-proxy.ts'

const PROJECT = '/proj'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`destroy-${String(nextRpc++)}`), payload }
}

const sid = (id: string): SessionId => id as SessionId

/** One model reply, or a reply that streams one chunk and then hangs until aborted. */
type ScriptEntry = StreamChunk[] | 'hang'

class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('ScriptedAdapter: script exhausted')
    if (entry === 'hang') {
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text: 'partial' }
      await new Promise<void>((_resolve, reject) => {
        const fail = (): void => { reject(new Error('aborted')) }
        if (options.signal?.aborted) { fail(); return }
        options.signal?.addEventListener('abort', fail, { once: true })
      })
      return
    }
    for (const chunk of entry) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 5, outputTokens: text.length } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

const homes: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

/** The composed host surface a Web deployment runs, rooted in one temporary home. */
async function boot(script: ScriptEntry[]): Promise<{
  ctx: Context
  home: string
  api: ReturnType<typeof createApiProxy>
  persistence: JsonlSessionPersistence
}> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-destroy-'))
  homes.push(home)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(script))
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
  await ctx.plugin(Storage)
  await ctx.plugin({ apply: applyStorageJson, inject: storageJsonInject, Config: StorageJsonConfig },
    { root: join(home, 'storages') })
  await ctx.plugin({ apply: applyStorageDomain, inject: storageDomainInject, Config: StorageDomainConfig },
    { backend: 'json' })
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1, writeIntervalMs: 1 })
  const api = createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock-model' }),
    cwd: PROJECT,
  })
  return { ctx, home, api, persistence: ctx.sessionPersistence as JsonlSessionPersistence }
}

/** Create a session through the normal path and run one completed turn into its log. */
async function liveSession(
  ctx: Context,
  api: ReturnType<typeof createApiProxy>,
): Promise<Session> {
  const created = await api.sessions.create(request({ cwd: PROJECT }))
  if (!created.result.ok) throw new Error(`create failed: ${created.result.error.message}`)
  const sessionId = created.result.value.sessionId
  const prompted = await api.sessions.prompt(request({
    sessionId,
    mode: 'queue' as const,
    content: [{ type: 'text' as const, text: 'hello' }],
  }))
  if (!prompted.result.ok) throw new Error(`prompt failed: ${prompted.result.error.message}`)
  const agent = ctx.agents.get(sessionId)
  if (agent === undefined) throw new Error('agent did not publish')
  await agent.whenIdle()
  const session = ctx.sessions.get(sessionId)
  if (session === undefined) throw new Error('session did not stay attached')
  // Durability barrier: the write-behind buffer must be on disk before the test
  // reasons about a log that exists.
  await ctx.sessions.flush(session)
  return session
}

/**
 * Persist one detached subagent conversation, the way a spawned child's own log
 * exists after its turn ended: header with subagent lineage plus a closed turn.
 */
async function storedSubagent(
  persistence: JsonlSessionPersistence,
  id: SessionId,
  cwd: string,
  parentSession: SessionId,
): Promise<string> {
  const header = {
    id,
    version: SESSION_FORMAT_VERSION,
    createdAt: Date.now(),
    cwd,
    parentSession,
    origin: 'subagent' as const,
  }
  await persistence.create(header)
  await persistence.append(id, [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as never)
  const location = persistence.locate(header)
  if (location === undefined) throw new Error('jsonl backend always locates an artifact')
  return location.path
}

/** Log path this backend would write for a session (the artifact the test watches). */
function logPathOf(persistence: JsonlSessionPersistence, session: Session): string {
  const location = persistence.locate(session.header)
  if (location === undefined) throw new Error('jsonl backend always locates an artifact')
  return location.path
}

/** Stored checkpoint text, or '' while the fire-and-forget write has not landed yet. */
async function checkpointText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return ''
  }
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

describe('sessions.destroy', () => {
  it('deletes the conversation, its checkpoint and its workspace accounting', async () => {
    const { ctx, home, api, persistence } = await boot([textResponse('hi there')])
    const session = await liveSession(ctx, api)
    const sessionId = session.id
    const logPath = logPathOf(persistence, session)
    expect(await exists(logPath)).toBe(true)
    // The checkpoint is written on turn/end, so the id is durably present before
    // the destroy — otherwise the "row is gone" assertion below would be vacuous.
    const checkpointFile = join(home, 'storages', 'session_projcache.json')
    // The checkpoint write is fire-and-forget behind the turn/end flush, so the
    // row is awaited rather than assumed.
    await expect.poll(async () => checkpointText(checkpointFile)).toContain(String(sessionId))

    const destroyed = await api.sessions.destroy(request({ sessionId }))
    expect(destroyed.result).toMatchObject({ ok: true, value: { sessionId, descendants: [] } })

    expect(await exists(logPath)).toBe(false)
    expect(await checkpointText(checkpointFile)).not.toContain(String(sessionId))
    const listed = await api.sessions.list(request({}))
    if (!listed.result.ok) throw new Error('list failed')
    expect(listed.result.value.items.map(item => item.sessionId)).not.toContain(sessionId)
    const history = await api.sessions.history(request({ sessionId }))
    expect(history.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    for (const workspace of ctx.workspaceRegistry.list()) {
      expect(workspace.sessionIds).not.toContain(sessionId)
    }
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    expect(ctx.sessions.get(sessionId)).toBeUndefined()
  })

  it('drops archive membership so a destroyed id is not left archived', async () => {
    const { ctx, api, persistence } = await boot([textResponse('archived')])
    const session = await liveSession(ctx, api)
    await ctx.workspaceRegistry.archiveSession(session.id)
    expect(ctx.workspaceRegistry.archivedSessionIds).toContain(session.id)

    const destroyed = await api.sessions.destroy(request({ sessionId: session.id }))
    expect(destroyed.result.ok).toBe(true)
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(session.id)
    expect(await exists(logPathOf(persistence, session))).toBe(false)
  })

  it('cancels a running turn and waits for it before deleting the log', async () => {
    const { ctx, api, persistence } = await boot(['hang'])
    const created = await api.sessions.create(request({ cwd: PROJECT }))
    if (!created.result.ok) throw new Error('create failed')
    const sessionId = created.result.value.sessionId
    const prompted = await api.sessions.prompt(request({
      sessionId,
      mode: 'queue' as const,
      content: [{ type: 'text' as const, text: 'long task' }],
    }))
    if (!prompted.result.ok) throw new Error('prompt failed')
    const agent = ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('agent did not publish')
    // The turn is genuinely in flight: the adapter has not been aborted yet.
    await expect.poll(() => ctx.agents.get(sessionId)?.status).toBe('running')

    const destroyed = await api.sessions.destroy(request({ sessionId }))
    expect(destroyed.result.ok).toBe(true)
    expect(ctx.agents.get(sessionId)).toBeUndefined()
    // A turn that ran means a log existed; the destroy removed it.
    const stored = await persistence.list()
    expect(stored.map(header => String(header.id))).not.toContain(String(sessionId))
  })

  it('destroys subagent descendants recursively and leaves ordinary forks alone', async () => {
    const { ctx, api, persistence } = await boot([textResponse('parent'), textResponse('fork')])
    const parent = await liveSession(ctx, api)
    // Cold subagent descendants: persisted conversations a client could still
    // open, started by the parent and by that child. Written through the normal
    // persistence path, never attached — a detached child is what the host
    // actually finds after the turn that spawned it ended.
    const childId = sid('session-child')
    const grandchildId = sid('session-grandchild')
    const childLog = await storedSubagent(persistence, childId, PROJECT, parent.id)
    const grandchildLog = await storedSubagent(persistence, grandchildId, PROJECT, childId)
    expect(await exists(childLog)).toBe(true)
    expect(await exists(grandchildLog)).toBe(true)
    // An ordinary fork names the parent as lineage and is its own conversation.
    const forked = await api.sessions.fork(request({ sessionId: parent.id }))
    if (!forked.result.ok) throw new Error('fork failed')
    const forkId = forked.result.value.sessionId
    const forkSession = ctx.sessions.get(forkId) as Session
    await ctx.sessions.flush(forkSession)
    const forkLog = logPathOf(persistence, forkSession)
    expect(await exists(forkLog)).toBe(true)

    const destroyed = await api.sessions.destroy(request({ sessionId: parent.id }))
    if (!destroyed.result.ok) throw new Error(`destroy failed: ${destroyed.result.error.message}`)
    expect(new Set(destroyed.result.value.descendants)).toEqual(new Set([childId, grandchildId]))
    expect(await exists(childLog)).toBe(false)
    expect(await exists(grandchildLog)).toBe(false)
    const listed = await api.sessions.list(request({}))
    if (!listed.result.ok) throw new Error('list failed')
    const listedIds = listed.result.value.items.map(item => String(item.sessionId))
    expect(listedIds).not.toContain(String(parent.id))
    expect(listedIds).not.toContain(String(childId))
    expect(listedIds).not.toContain(String(grandchildId))
    // The fork survives and stays openable.
    expect(await exists(forkLog)).toBe(true)
    const forkHistory = await api.sessions.history(request({ sessionId: forkId }))
    expect(forkHistory.result.ok).toBe(true)
  })

  it('rejects an unknown id and a second destroy of the same id', async () => {
    const { ctx, api } = await boot([textResponse('once')])
    const unknown = await api.sessions.destroy(request({ sessionId: sid('session-never-existed') }))
    expect(unknown.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })

    const session = await liveSession(ctx, api)
    const first = await api.sessions.destroy(request({ sessionId: session.id }))
    expect(first.result.ok).toBe(true)
    const second = await api.sessions.destroy(request({ sessionId: session.id }))
    expect(second.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
  })

  it('does not claim success when the composed backend cannot delete', async () => {
    // A deployment whose backend declares no delete capability must refuse the
    // request before anything is torn down: the conversation stays intact and
    // the RPC reports a failure, never a fake success.
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('kept')]))
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    ctx.provide('sessionPersistence', {
      name: 'session-persistence-undeletable',
      supportsDestroy: false,
    } as never)
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'mock', model: 'mock-model' }),
      cwd: PROJECT,
    })
    const created = await api.sessions.create(request({ cwd: PROJECT }))
    if (!created.result.ok) throw new Error('create failed')
    const sessionId = created.result.value.sessionId

    const refused = await api.sessions.destroy(request({ sessionId }))
    expect(refused.result).toMatchObject({ ok: false, error: { code: 'internal' } })
    expect(ctx.agents.get(sessionId)).toBeDefined()
    expect(ctx.sessions.get(sessionId)).toBeDefined()
  })

  it('leaves nothing behind across a cold boot of the same home', async () => {
    const first = await boot([textResponse('survives as history')])
    const session = await liveSession(first.ctx, first.api)
    const sessionId = session.id
    const logPath = logPathOf(first.persistence, session)
    const destroyed = await first.api.sessions.destroy(request({ sessionId }))
    expect(destroyed.result.ok).toBe(true)
    await first.ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    // Rebuild the persistence and registry layer exactly as the boot path does:
    // same home, same files, no carry-over of in-memory state.
    const home = first.home
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(LlmRuntime)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([]))
    await ctx.plugin(SessionStore)
    await ctx.plugin(UserQuestionService)
    await ctx.plugin(SystemPrompt, { persona: '' })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(JsonlSessionPersistence, { root: join(home, 'sessions') })
    await ctx.plugin(Storage)
    await ctx.plugin({ apply: applyStorageJson, inject: storageJsonInject, Config: StorageJsonConfig },
      { root: join(home, 'storages') })
    await ctx.plugin({ apply: applyStorageDomain, inject: storageDomainInject, Config: StorageDomainConfig },
      { backend: 'json' })
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 1, writeIntervalMs: 1 })
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'mock', model: 'mock-model' }),
      cwd: PROJECT,
    })

    expect(await exists(logPath)).toBe(false)
    const listed = await api.sessions.list(request({}))
    if (!listed.result.ok) throw new Error('list failed')
    expect(listed.result.value.items.map(item => item.sessionId)).not.toContain(sessionId)
    const history = await api.sessions.history(request({ sessionId }))
    expect(history.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })
    for (const workspace of ctx.workspaceRegistry.list()) {
      expect(workspace.sessionIds).not.toContain(sessionId)
    }
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(sessionId)
    expect(await checkpointText(join(home, 'storages', 'session_projcache.json'))).not.toContain(String(sessionId))
  })
})
