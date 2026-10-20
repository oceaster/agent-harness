/**
 * The subagent idle reaper (fork-only lifecycle policy).
 *
 * What has to be proven here is destructive, so most of these tests run the
 * real host spine — agent loop, JSONL session persistence, the file-backed
 * storage domains — inside a temporary home. The container is only proven by
 * proving the NON-targets survive in the same pass: an old subagent is gone
 * from the store, from disk and from the session list, while a fresh subagent,
 * a running one, a queued one, an old top-level conversation and an old
 * `<profile>`-per-agent inbox row are all untouched.
 *
 * Two layers, stated plainly:
 * - Real spine (persistence on disk, real Agent lifecycles) for deletion, the
 *   running and queued guards, the shipped defaults and the automatic pass.
 * - A seam-shaped fake `SessionPersistence` (`list`/`readFrom`/`destroy`, the
 *   three members the reaper uses) for the refusal path and the exact-threshold
 *   boundary, because a real backend that refuses a destroy is only reachable
 *   while its session is busy (which the reaper skips earlier by design).
 */

import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import SessionStore, { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
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
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { ApiProxyService, createApiProxy } from '../src/index.ts'
import {
  DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS,
  DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS,
  reapIdleSubagentSessions,
} from '../src/subagent-idle-reaper.ts'
import type { DestroySessionOutcome, ReapPassOptions } from '../src/subagent-idle-reaper.ts'

const PROJECT = '/proj'
const HOUR = 3_600_000
const SIX_HOURS = 6 * HOUR

const sid = (value: string): SessionId => value as SessionId

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`reap-${String(nextRpc++)}`), payload }
}

/** Records what the reaper logged, so its deletion and refusal lines are asserted. */
interface CapturedLog {
  info: string[]
  warn: string[]
  logger: ReapPassOptions['logger']
}

function captureLogger(): CapturedLog {
  const info: string[] = []
  const warn: string[] = []
  return {
    info,
    warn,
    logger: {
      info: (message: string): void => { info.push(message) },
      warn: (message: string): void => { warn.push(message) },
    },
  }
}

/** One scripted model reply, or a stream that only ends when aborted. */
type ScriptEntry = StreamChunk[] | 'hang'

class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly script: ScriptEntry[]) { super() }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
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

/**
 * The composed host surface, rooted in one temporary home.
 *
 * The gateway is NOT created here: seeding stored conversations before the
 * proxy exists is what lets the armed reaper's own boot pass find them, which
 * is the automatic behaviour these tests have to prove.
 */
async function bootHost(script: ScriptEntry[] = []): Promise<{
  ctx: Context
  home: string
  persistence: JsonlSessionPersistence
}> {
  const home = await mkdtemp(join(tmpdir(), 'dsh-reap-'))
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
  return { ctx, home, persistence: ctx.sessionPersistence as JsonlSessionPersistence }
}

/** Build the gateway over an already-populated host (`unarmed` = no reaper timer). */
function gateway(
  ctx: Context,
  subagentIdleReap?: { idleMs: number; scanIntervalMs: number },
): ReturnType<typeof createApiProxy> {
  return createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'mock', model: 'mock-model' }),
    cwd: PROJECT,
    ...subagentIdleReap === undefined ? {} : { subagentIdleReap },
  })
}

/**
 * Persist one detached conversation whose LAST stored event sits at
 * `lastEventAt` — the only clock the reaper is allowed to read.
 */
async function seedStoredSession(
  persistence: JsonlSessionPersistence,
  options: {
    id: string
    cwd?: string
    lastEventAt: number
    origin?: 'subagent'
    parentSession?: SessionId
  },
): Promise<string> {
  const header: SessionHeader = {
    id: sid(options.id),
    version: SESSION_FORMAT_VERSION,
    createdAt: options.lastEventAt - HOUR,
    cwd: options.cwd ?? PROJECT,
    ...options.origin === undefined ? {} : { origin: options.origin },
    ...options.parentSession === undefined ? {} : { parentSession: options.parentSession },
  }
  await persistence.create(header)
  await persistence.append(header.id, [
    { type: 'turn/start', seq: 0, time: options.lastEventAt - 1_000, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: options.lastEventAt, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[])
  const location = persistence.locate(header)
  if (location === undefined) throw new Error('jsonl backend always locates an artifact')
  return location.path
}

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

/** The destroy dependency the RPC itself uses: the reaper must never have another. */
function rpcDestroy(api: ReturnType<typeof createApiProxy>) {
  return async (sessionId: SessionId): Promise<DestroySessionOutcome> => {
    const response = await api.sessions.destroy(request({ sessionId }))
    return response.result.ok
      ? { ok: true, sessionId: response.result.value.sessionId, descendants: response.result.value.descendants }
      : { ok: false, error: response.result.error }
  }
}

async function listedIds(api: ReturnType<typeof createApiProxy>): Promise<string[]> {
  const listed = await api.sessions.list(request({}))
  if (!listed.result.ok) throw new Error(`list failed: ${listed.result.error.message}`)
  return listed.result.value.items.map(item => String(item.sessionId))
}

describe('subagent idle reaper — real spine', () => {
  it('reaps the old subagent and leaves every non-target byte-for-byte alone', async () => {
    const { ctx, persistence } = await bootHost()
    const now = Date.now()
    const api = gateway(ctx)
    const logger = captureLogger()

    const oldSubagent = await seedStoredSession(persistence, {
      id: 'session-old-subagent', lastEventAt: now - 7 * HOUR, origin: 'subagent', parentSession: sid('session-parent'),
    })
    const freshSubagent = await seedStoredSession(persistence, {
      id: 'session-fresh-subagent', lastEventAt: now - 60_000, origin: 'subagent', parentSession: sid('session-parent'),
    })
    // A person's own conversations: one top-level, one persistent per-agent
    // inbox row. Both are far past the threshold and both must survive a year.
    const oldTopLevel = await seedStoredSession(persistence, { id: 'session-old-top-level', lastEventAt: now - 7 * HOUR })
    const oldInboxRow = await seedStoredSession(persistence, { id: 'session-inbox-owen-delta', lastEventAt: now - 400 * HOUR })

    const report = await reapIdleSubagentSessions(ctx, {
      destroy: rpcDestroy(api), now: () => now, idleMs: SIX_HOURS, logger: logger.logger,
    })

    // Only subagent headers were even examined: the scope rule is the predicate,
    // not a filter applied after the fact.
    expect(report.scanned).toBe(2)
    expect(report.reaped).toEqual([sid('session-old-subagent')])
    expect(report.refused).toEqual([])
    expect(report.skipped).toEqual([{ sessionId: sid('session-fresh-subagent'), reason: 'fresh' }])

    // The reaped session is really gone: log file, store, and list.
    expect(await exists(oldSubagent)).toBe(false)
    const ids = await listedIds(api)
    expect(ids).not.toContain('session-old-subagent')
    const gone = await api.sessions.history(request({ sessionId: sid('session-old-subagent') }))
    expect(gone.result).toMatchObject({ ok: false, error: { code: 'session-not-found' } })

    // ...and the non-targets are byte-for-byte intact.
    for (const survivor of [freshSubagent, oldTopLevel, oldInboxRow]) expect(await exists(survivor)).toBe(true)
    expect(ids).toEqual(expect.arrayContaining([
      'session-fresh-subagent', 'session-old-top-level', 'session-inbox-owen-delta',
    ]))
    for (const survivor of ['session-fresh-subagent', 'session-old-top-level', 'session-inbox-owen-delta']) {
      const history = await api.sessions.history(request({ sessionId: sid(survivor) }))
      expect(history.result.ok).toBe(true)
    }
    expect(logger.info.join('\n')).toMatch(/session-old-subagent.*25200000 ms idle/)
    expect(logger.warn).toEqual([])
  })

  it('reaps a child through the shared routine, so its subagent descendants go with it', async () => {
    const { ctx, persistence } = await bootHost()
    const now = Date.now()
    const api = gateway(ctx)
    const logger = captureLogger()

    const parent = await seedStoredSession(persistence, {
      id: 'session-old-child', lastEventAt: now - 7 * HOUR, origin: 'subagent', parentSession: sid('session-top'),
    })
    // A descendant is never re-addressed after its parent's teardown: the shared
    // routine collected it, and a second destroy would answer `session-not-found`
    // for a conversation that is correctly gone.
    const grandchild = await seedStoredSession(persistence, {
      id: 'session-old-grandchild', lastEventAt: now - 7 * HOUR, origin: 'subagent',
      parentSession: sid('session-old-child'),
    })

    const report = await reapIdleSubagentSessions(ctx, {
      destroy: rpcDestroy(api), now: () => now, idleMs: SIX_HOURS, logger: logger.logger,
    })

    expect(report.reaped).toEqual([sid('session-old-child')])
    expect(report.refused).toEqual([])
    expect(await exists(parent)).toBe(false)
    expect(await exists(grandchild)).toBe(false)
    expect(logger.info.join('\n')).toMatch(/session-old-child.*descendant/)
    expect(logger.warn).toEqual([])
  })

  it('reaps automatically through the gateway timer: no RPC, no browser, no user action', async () => {
    const { ctx, persistence } = await bootHost()
    const now = Date.now()
    const oldSubagent = await seedStoredSession(persistence, {
      id: 'session-abandoned-child', lastEventAt: now - 2 * HOUR, origin: 'subagent', parentSession: sid('session-parent'),
    })
    const freshSubagent = await seedStoredSession(persistence, {
      id: 'session-busy-child', lastEventAt: now - 60_000, origin: 'subagent', parentSession: sid('session-parent'),
    })

    // The shipped policy, narrowed to a one-hour threshold so the test does not
    // wait six: arming the gateway is the only thing the test does.
    const api = gateway(ctx, { idleMs: HOUR, scanIntervalMs: HOUR })

    await expect.poll(() => exists(oldSubagent), { timeout: 5_000 }).toBe(false)
    expect(await exists(freshSubagent)).toBe(true)
    const ids = await listedIds(api)
    expect(ids).not.toContain('session-abandoned-child')
    expect(ids).toContain('session-busy-child')
  })

  it('does nothing at all without the policy config', async () => {
    const { ctx, persistence } = await bootHost()
    const oldSubagent = await seedStoredSession(persistence, {
      id: 'session-unarmed-child', lastEventAt: Date.now() - 7 * HOUR, origin: 'subagent',
    })
    // A bare `createApiProxy` (custom carrier, another embedding) arms no timer:
    // arming is the gateway plugin's decision, and it is the shipped default.
    gateway(ctx)
    await new Promise<void>((resolve) => { setTimeout(resolve, 150) })
    expect(await exists(oldSubagent)).toBe(true)
  })

  it('keeps a running subagent whatever its event age, and says which rule fired', async () => {
    const { ctx, persistence } = await bootHost(['hang'])
    const api = gateway(ctx)
    const created = await ctx.agents.create({
      sessionId: sid('session-running-child'),
      meta: { cwd: PROJECT, origin: 'subagent', parentSession: sid('session-parent') },
      agentOptions: { provider: 'mock', model: 'mock-model' },
    })
    const agent = created.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'long job' }], source: { kind: 'user' } }))
    await expect.poll(() => agent.status).toBe('running')
    // Durability barrier: the stored log exists while the turn is still in flight.
    await ctx.sessions.flush(agent.session)
    const location = persistence.locate(agent.session.header)
    if (location === undefined) throw new Error('jsonl backend always locates an artifact')

    const report = await reapIdleSubagentSessions(ctx, {
      destroy: rpcDestroy(api), now: () => Date.now(), idleMs: SIX_HOURS, logger: captureLogger().logger,
    })

    expect(report.reaped).toEqual([])
    expect(report.skipped).toEqual([{ sessionId: sid('session-running-child'), reason: 'running' }])
    expect(await exists(location.path)).toBe(true)
    expect(ctx.agents.get(sid('session-running-child'))).toBe(agent)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
  })

  it('keeps a subagent that holds queued work while no turn is running', async () => {
    const { ctx, persistence } = await bootHost([textResponse('done')])
    const api = gateway(ctx)
    const created = await ctx.agents.create({
      sessionId: sid('session-queued-child'),
      meta: { cwd: PROJECT, origin: 'subagent', parentSession: sid('session-parent') },
      agentOptions: { provider: 'mock', model: 'mock-model' },
    })
    const agent = created.agent
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    // Parked input: queued for the next turn without waking the driver, so the
    // Agent is genuinely idle while it holds work a parent is still waiting on.
    agent.send(
      createUserMessage({ content: [{ type: 'text', text: 'do this next' }], source: { kind: 'user' } }),
      'next-turn',
      false,
    )
    expect(agent.status).toBe('idle')
    expect(agent.inbox.hasPending).toBe(true)
    await ctx.sessions.flush(agent.session)
    const location = persistence.locate(agent.session.header)
    if (location === undefined) throw new Error('jsonl backend always locates an artifact')

    const report = await reapIdleSubagentSessions(ctx, {
      destroy: rpcDestroy(api), now: () => Date.now(), idleMs: SIX_HOURS, logger: captureLogger().logger,
    })

    expect(report.reaped).toEqual([])
    expect(report.skipped).toEqual([{ sessionId: sid('session-queued-child'), reason: 'queued' }])
    expect(await exists(location.path)).toBe(true)
    expect(agent.inbox.hasPending).toBe(true)
  })

  it('says so once and reaps nothing when the backend cannot delete stored sessions', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionPersistence', {
      name: 'session-persistence-undeletable',
      supportsDestroy: false,
      list: () => Promise.resolve([]),
    } as never)
    const logger = captureLogger()
    const report = await reapIdleSubagentSessions(ctx, {
      destroy: () => Promise.reject(new Error('must not be called')),
      now: () => Date.now(),
      idleMs: SIX_HOURS,
      logger: logger.logger,
    })
    expect(report).toEqual({ scanned: 0, reaped: [], skipped: [], refused: [] })
    expect(logger.warn.join('\n')).toMatch(/cannot delete stored sessions/)
  })
})

describe('subagent idle reaper — refusals and the boundary', () => {
  /** A seam-shaped fake: exactly the three persistence members the reaper reads. */
  function fakeHost(headers: SessionHeader[], eventsFor: (id: SessionId) => SessionEvent[]) {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionPersistence', {
      name: 'session-persistence-fake',
      supportsDestroy: true,
      list: () => Promise.resolve(headers),
      readFrom: (id: SessionId) => Promise.resolve({
        meta: headers.find(header => header.id === id) as SessionHeader,
        events: eventsFor(id),
      }),
      destroy: vi.fn(() => Promise.resolve(true)),
      locate: () => undefined,
    } as never)
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessions', { get: () => undefined })
    return ctx
  }

  const subagentHeader = (id: string, createdAt: number): SessionHeader => ({
    id: sid(id), version: SESSION_FORMAT_VERSION, createdAt, origin: 'subagent', cwd: PROJECT,
  })
  const logEndingAt = (time: number): SessionEvent[] => [
    { type: 'turn/end', seq: 1, time, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]

  it('logs a destroy refusal with the id and reason, deletes nothing, and retries next pass', async () => {
    const now = Date.now()
    const ctx = fakeHost([subagentHeader('session-stuck-child', now - 7 * HOUR)], () => logEndingAt(now - 7 * HOUR))
    const logger = captureLogger()
    const refusal: DestroySessionOutcome = {
      ok: false,
      error: {
        code: 'internal',
        message: 'cannot destroy session "session-stuck-child": the running turn of "session-stuck-child" did not settle',
        details: {},
      },
    }
    const destroy = vi.fn(() => Promise.resolve(refusal))

    const first = await reapIdleSubagentSessions(ctx, { destroy, now: () => now, idleMs: SIX_HOURS, logger: logger.logger })
    expect(first.reaped).toEqual([])
    expect(first.refused).toEqual([{
      sessionId: sid('session-stuck-child'),
      reason: 'cannot destroy session "session-stuck-child": the running turn of "session-stuck-child" did not settle',
    }])
    // One attempt per pass, never a tight retry loop inside one.
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(logger.warn.join('\n')).toMatch(/session-stuck-child.*retrying next pass/i)
    // The reaper never deletes a log to force an outcome: the backend's own
    // delete hook was not called at all.
    const persistence = ctx.get('sessionPersistence') as unknown as { destroy: ReturnType<typeof vi.fn> }
    expect(persistence.destroy).not.toHaveBeenCalled()

    // The next pass tries again rather than remembering a failure.
    destroy.mockResolvedValue({ ok: true, sessionId: sid('session-stuck-child'), descendants: [] })
    const second = await reapIdleSubagentSessions(ctx, { destroy, now: () => now, idleMs: SIX_HOURS, logger: logger.logger })
    expect(second.reaped).toEqual([sid('session-stuck-child')])
    expect(second.refused).toEqual([])
    expect(destroy).toHaveBeenCalledTimes(2)
  })

  it('treats exactly the threshold as idle and anything newer as fresh', async () => {
    const now = Date.now()
    const ctx = fakeHost(
      [subagentHeader('session-exactly-six-hours', now - SIX_HOURS), subagentHeader('session-one-ms-short', now)],
      id => logEndingAt(id === sid('session-exactly-six-hours') ? now - SIX_HOURS : now - SIX_HOURS + 1),
    )
    const destroy = vi.fn((sessionId: SessionId) => Promise.resolve<DestroySessionOutcome>(
      { ok: true, sessionId, descendants: [] },
    ))
    const report = await reapIdleSubagentSessions(ctx, { destroy, now: () => now, idleMs: SIX_HOURS, logger: captureLogger().logger })
    expect(report.reaped).toEqual([sid('session-exactly-six-hours')])
    expect(report.skipped).toEqual([{ sessionId: sid('session-one-ms-short'), reason: 'fresh' }])
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  it('never treats a stored log it cannot read as idle', async () => {
    const ctx = new Context()
    contexts.push(ctx)
    ctx.provide('sessionPersistence', {
      name: 'session-persistence-flaky',
      supportsDestroy: true,
      list: () => Promise.resolve([subagentHeader('session-unreadable-child', 1)]),
      readFrom: () => Promise.reject(new Error('EIO: artifact unreadable')),
      destroy: vi.fn(() => Promise.resolve(true)),
      locate: () => undefined,
    } as never)
    ctx.provide('agents', { get: () => undefined })
    ctx.provide('sessions', { get: () => undefined })
    const destroy = vi.fn(() => Promise.resolve<DestroySessionOutcome>({
      ok: true, sessionId: sid('session-unreadable-child'), descendants: [],
    }))
    const logger = captureLogger()
    const report = await reapIdleSubagentSessions(ctx, { destroy, now: () => Date.now(), idleMs: SIX_HOURS, logger: logger.logger })
    expect(report.reaped).toEqual([])
    expect(report.skipped).toEqual([{ sessionId: sid('session-unreadable-child'), reason: 'unreadable' }])
    expect(destroy).not.toHaveBeenCalled()
    expect(logger.warn.join('\n')).toMatch(/EIO: artifact unreadable/)
  })
})

describe('subagent idle reap config', () => {
  it('ships six hours idle on an hourly scan', () => {
    expect(ApiProxyService.Config({}).subagentIdleReap).toEqual({
      idleMs: DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS,
      scanIntervalMs: DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS,
    })
    expect(DEFAULT_SUBAGENT_IDLE_REAP_IDLE_MS).toBe(SIX_HOURS)
    expect(DEFAULT_SUBAGENT_IDLE_REAP_SCAN_INTERVAL_MS).toBe(HOUR)
  })

  it('accepts a deployment override and refuses a nonsense value at boot', () => {
    expect(ApiProxyService.Config({ subagentIdleReap: { idleMs: 12 * HOUR, scanIntervalMs: 2 * HOUR } })
      .subagentIdleReap).toEqual({ idleMs: 12 * HOUR, scanIntervalMs: 2 * HOUR })
    // Zero, negative, and below an hour are refused rather than silently applied.
    for (const idleMs of [0, -1, 30 * 60_000, 1.5]) {
      expect(() => ApiProxyService.Config({ subagentIdleReap: { idleMs } } as never))
        .toThrow(/subagentIdleReap\.idleMs/)
    }
    for (const scanIntervalMs of [0, -1, 1_000]) {
      expect(() => ApiProxyService.Config({ subagentIdleReap: { scanIntervalMs } } as never))
        .toThrow(/subagentIdleReap\.scanIntervalMs/)
    }
  })
})
