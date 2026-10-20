/**
 * Behavior of the auto-refreshing advisory catalog: the built-in list, the
 * provider's own `GET /models` listing, and the precedence between them.
 *
 * Every case drives the real plugin composition — LlmRuntime plus this plugin,
 * with the settings and credential providers mounted where the case needs them —
 * and asserts what a catalog consumer (`ctx.llm.listModels` /
 * `ctx.llm.resolveModelInfo`) actually sees. Listing replies come from
 * `tests/mock-server.ts`, so no case reaches the network.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import { closeMockServers, mockServer } from './mock-server.ts'
import type { Behavior, MockServer } from './mock-server.ts'

const NS = settingsNamespace('llm-deepseek')

/** The provider's own listing, as `api.deepseek.com` answers it today. */
const providerListing = JSON.stringify({
  object: 'list',
  data: [
    {
      id: 'deepseek-flash',
      object: 'model',
      name: 'DeepSeek-V4.1-Flash',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
      input_modalities: ['text', 'image'],
    },
    {
      id: 'deepseek-v4-pro',
      object: 'model',
      name: 'DeepSeek-V4-Pro',
      context_window: 1_048_576,
      max_output_tokens: 393_216,
      input_modalities: ['text'],
    },
  ],
})

/** A listing that advertises models this build has never heard of. */
const nextListing = JSON.stringify({
  object: 'list',
  data: [
    { id: 'deepseek-flash-next', name: 'DeepSeek-V5-Flash', context_window: 2_000_000, max_output_tokens: 500_000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
  ],
})

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
  await closeMockServers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-llm-catalog-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

interface Harness {
  ctx: Context
  /** The plugin's own fiber, for the cases that dispose it. */
  fiber: { dispose(): Promise<void> }
}

interface BootOptions {
  /** Mount the file settings and local credential providers over a temp harness home. */
  dynamic?: boolean
  /** Stub `DEEPSEEK_API_KEY` in the launch environment before the plugin loads. */
  apiKey?: string
}

/**
 * Boot the real composition: LlmRuntime plus this plugin, optionally with the
 * settings and credential providers the live profile mounts.
 */
async function boot(config: object, options: BootOptions = {}): Promise<Harness> {
  if (options.apiKey !== undefined) vi.stubEnv('DEEPSEEK_API_KEY', options.apiKey)
  const dir = options.dynamic === true ? await home() : undefined
  if (dir !== undefined) {
    vi.stubEnv('DSH_HOME', dir)
    await writeFile(join(dir, 'settings.yaml'), '# personal settings\n')
    await writeFile(join(dir, '.credentials.yaml'), 'DEEPSEEK_API_KEY: listing-key\n', { mode: 0o600 })
  }
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  if (dir !== undefined) {
    const settingsFiber = ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
    await settingsFiber
    await ctx.plugin(LocalCredentialProvider, { path: join(dir, '.credentials.yaml'), watch: false })
  }
  const fiber = ctx.plugin(LlmDeepSeek, config)
  await fiber
  return { ctx, fiber }
}

/** Capture the advisory diagnostics this plugin emits, without writing them to the test log. */
function warnings(ctx: Context): string[] {
  const captured: string[] = []
  vi.spyOn(ctx.logger, 'warn').mockImplementation(((message: string) => {
    captured.push(message)
  }) as never)
  return captured
}

/**
 * Wait until the mock server has answered `count` listing interrogations and the
 * refresh that followed has been applied.
 */
async function settle(server: MockServer, count = 1): Promise<void> {
  await vi.waitFor(() => { expect(server.listingRequests).toHaveLength(count) })
  // The result applies in the microtask chain that follows the reply.
  await new Promise(resolve => setTimeout(resolve, 25))
}

/** The model ids one catalog read advertises. */
async function ids(ctx: Context): Promise<string[]> {
  return (await ctx.llm.listModels('deepseek-official')).map(model => model.id)
}

describe('advisory catalog from the provider listing', () => {
  it('serves the built-in catalog first, then the listing on the next read', async () => {
    const server = await mockServer([], [{ kind: 'listing', body: providerListing }])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })

    // The read that starts the refresh still sees the built-in catalog: a turn
    // never waits for the network.
    await expect(ctx.llm.listModels('deepseek-official')).resolves.toEqual([
      {
        provider: 'deepseek-official',
        id: 'deepseek-flash',
        name: 'DeepSeek-V4.1-Flash',
        inputModalities: ['text', 'image'],
      },
      {
        provider: 'deepseek-official',
        id: 'deepseek-v4-pro',
        name: 'DeepSeek-V4-Pro',
        inputModalities: ['text'],
      },
    ])
    await settle(server)
    // One interrogation, carrying this route's own credential, and the result
    // applies from the next read.
    expect(server.listingRequests).toHaveLength(1)
    expect(server.listingRequests[0]?.url).toBe('/models')
    expect(server.listingRequests[0]?.headers.authorization).toBe('Bearer sk-listing')
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek-V4.1-Flash',
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 393_216,
      inputModalities: ['text', 'image'],
    })
    // Repeated reads inside the interval never start a second interrogation.
    await expect(ids(ctx)).resolves.toHaveLength(2)
    expect(server.listingRequests).toHaveLength(1)
  })

  it('replaces the catalog with ids the listing newly advertises', async () => {
    const server = await mockServer([], [{ kind: 'listing', body: nextListing }])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })
    warnings(ctx)

    await ids(ctx)
    await settle(server)
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash-next', 'deepseek-v4-pro'])
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash-next')).resolves.toMatchObject({
      name: 'DeepSeek-V5-Flash',
      context: { contextWindow: 2_000_000 },
      defaultMaxTokens: 500_000,
    })
  })

  it('keeps what the catalog knew for every field a listing withholds', async () => {
    // A gateway that reports ids and names but no capacities, and one model it
    // has never described. Withheld is not zero, and withheld modalities must
    // not silently turn image input off for an id the catalog knew accepts it.
    const server = await mockServer([], [{
      kind: 'listing',
      body: JSON.stringify({
        object: 'list',
        data: [
          { id: 'deepseek-flash', display_name: 'Flash Next' },
          { id: 'deepseek-never-seen' },
        ],
      }),
    }])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })
    warnings(ctx)

    await ids(ctx)
    await settle(server)
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')).resolves.toMatchObject({
      name: 'Flash Next',
      context: { contextWindow: 1_048_576 },
      defaultMaxTokens: 393_216,
      inputModalities: ['text', 'image'],
    })
    // An id the built-in catalog never described falls back per field to the
    // profile defaults, never to zero.
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-never-seen')).resolves.toMatchObject({
      name: 'deepseek-never-seen',
      context: { contextWindow: 1_000_000 },
      defaultMaxTokens: 256_000,
      inputModalities: ['text'],
    })
  })

  it('treats a 200 with an empty listing as no information', async () => {
    // The gateway this deployment points at answered exactly this before its
    // /v1/models route served the provider listing; adopting it would empty the
    // model selector for every route behind that endpoint.
    const server = await mockServer([], [{ kind: 'listing', body: '{"object":"list","data":[]}' }])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })
    const warn = warnings(ctx)

    await ids(ctx)
    await settle(server)
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('advertised no models')
  })

  it('deduplicates repeated ids in endpoint order and skips unusable rows', async () => {
    const server = await mockServer([], [{
      kind: 'listing',
      body: JSON.stringify({
        object: 'list',
        data: [
          { id: 'second', name: 'Second' },
          { name: 'no id at all' },
          { id: 42 },
          { id: 'first', name: 'First' },
          { id: 'second', name: 'Second again' },
        ],
      }),
    }])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })

    await ids(ctx)
    await settle(server)
    await expect(ids(ctx)).resolves.toEqual(['second', 'first'])
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'second')).resolves.toMatchObject({ name: 'Second' })
  })

  it('serves the built-in catalog at least and never blocks a read when the endpoint hangs', async () => {
    const server = await mockServer([], [{ kind: 'hang' }])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })

    const startedAt = Date.now()
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(Date.now() - startedAt).toBeLessThan(1_000)
    await vi.waitFor(() => { expect(server.listingRequests).toHaveLength(1) })
  })
})

describe('advisory catalog precedence', () => {
  it('never interrogates the endpoint when the composition pins a list', async () => {
    const server = await mockServer([], [{ kind: 'listing', body: providerListing }])
    const { ctx } = await boot({
      baseURL: server.url,
      models: [{ id: 'private-fast', name: 'Private Fast' }],
    }, { apiKey: 'sk-listing' })

    await expect(ids(ctx)).resolves.toEqual(['private-fast'])
    await ctx.llm.resolveModelInfo('deepseek-official', 'private-fast')
    await ids(ctx)
    // Skipped, not merely outvoted: no interrogation is ever sent.
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.listingRequests).toHaveLength(0)
    await expect(ids(ctx)).resolves.toEqual(['private-fast'])
  })

  it('never interrogates the endpoint when the stored section pins a list equal to the built-in one', async () => {
    const server = await mockServer([], [{ kind: 'listing', body: providerListing }])
    const { ctx } = await boot({ baseURL: server.url }, { dynamic: true })

    // A pin the operator wrote out verbatim is still an operator decision: it is
    // the stored section, not the resolved value, that says so.
    await ctx.settings.update(NS, {
      models: [
        {
          id: 'deepseek-flash',
          name: 'DeepSeek-V4.1-Flash',
          contextWindow: 1_048_576,
          maxTokens: 393_216,
          inputModalities: ['text', 'image'],
        },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_048_576, maxTokens: 393_216 },
      ],
    })

    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await ids(ctx)
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.listingRequests).toHaveLength(0)
  })

  it('re-reads the endpoint after a settings change and applies the new listing', async () => {
    const server = await mockServer([], [
      { kind: 'listing', body: providerListing },
      { kind: 'listing', body: nextListing },
    ])
    const { ctx } = await boot({ baseURL: server.url }, { dynamic: true })

    await ids(ctx)
    await settle(server, 1)
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])

    // Any committed change invalidates what was discovered for the previous
    // generation, so the next read interrogates the endpoint again.
    await ctx.settings.update(NS, { maxTokens: 4_096 })
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await settle(server, 2)
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash-next', 'deepseek-v4-pro'])
  })
})

describe('advisory catalog failure paths', () => {
  const failures: Array<[string, Behavior]> = [
    ['a gateway without the route', { kind: 'http-error', status: 404, body: '{"error":{"message":"no /models"}}' }],
    ['a refused credential', { kind: 'http-error', status: 401, body: '{"error":{"message":"bad key"}}' }],
    ['a malformed reply', { kind: 'listing', body: 'not json at all' }],
    ['a reply with no model list', { kind: 'listing', body: '{"object":"list"}' }],
    [
      'an oversized reply',
      { kind: 'listing', body: '{"data":[]}', headers: { 'content-length': String(64 * 1024 * 1024) } },
    ],
  ]

  it.each(failures)('keeps the catalog after %s, reporting it once', async (_case, behavior) => {
    const server = await mockServer([], [behavior])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })
    const warn = warnings(ctx)

    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await settle(server)
    expect(warn).toHaveLength(1)
    // Kept, not cleared: the last good catalog and the built-in fallback both
    // stay available to every consumer.
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')
    expect(server.listingRequests).toHaveLength(1)
  })

  it('keeps the last good catalog when a later refresh fails', async () => {
    const server = await mockServer([], [
      { kind: 'listing', body: nextListing },
      { kind: 'http-error', status: 503, body: 'upstream unavailable' },
    ])
    const { ctx } = await boot({ baseURL: server.url, catalogRefreshMs: 1 }, { apiKey: 'sk-listing' })
    warnings(ctx)

    await ids(ctx)
    await settle(server, 1)
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash-next', 'deepseek-v4-pro'])
    // The interval has elapsed, so the next read asks again and fails; the
    // catalog served stays the last one the endpoint actually confirmed.
    await ids(ctx)
    await settle(server, 2)
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash-next', 'deepseek-v4-pro'])
  })

  it('reports an unreachable endpoint once and serves the built-in catalog', async () => {
    const { ctx } = await boot({ baseURL: 'http://127.0.0.1:1' }, { apiKey: 'sk-listing' })
    const warn = warnings(ctx)

    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await vi.waitFor(() => { expect(warn).toHaveLength(1) })
    expect(warn[0]).toContain('model discovery against')
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(warn).toHaveLength(1)
  })

  it('fails fast without a credential, and keeps serving the catalog', async () => {
    const server = await mockServer([], [])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: '' })
    const warn = warnings(ctx)

    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await vi.waitFor(() => { expect(warn).toHaveLength(1) })
    expect(warn[0]).toContain('no credential')
    // No key means no request at all: the keyless boot never reaches out.
    expect(server.listingRequests).toHaveLength(0)
  })

  it('backs off across consecutive failures instead of retrying once per read', async () => {
    // A missing listing route must cost a handful of attempts, not one per turn:
    // forty reads over roughly two hundred milliseconds would be ten attempts
    // with a fixed twenty-millisecond interval, and each failure widens the wait.
    const server = await mockServer([], Array.from(
      { length: 40 },
      (): Behavior => ({ kind: 'http-error', status: 503, body: 'upstream down' }),
    ))
    const { ctx } = await boot({ baseURL: server.url, catalogRefreshMs: 20 }, { apiKey: 'sk-listing' })
    const warn = warnings(ctx)

    for (let read = 0; read < 40; read += 1) {
      await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-flash')
      await new Promise(resolve => setTimeout(resolve, 5))
    }

    expect(server.listingRequests.length).toBeGreaterThan(0)
    expect(server.listingRequests.length).toBeLessThanOrEqual(6)
    // One report per attempt, never one per read.
    expect(warn).toHaveLength(server.listingRequests.length)
  })

  it('does nothing when the refresh interval disables discovery', async () => {
    const server = await mockServer([], [{ kind: 'listing', body: nextListing }])
    const { ctx } = await boot({ baseURL: server.url, catalogRefreshMs: 0 }, { apiKey: 'sk-listing' })
    const warn = warnings(ctx)

    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.listingRequests).toHaveLength(0)
    expect(warn).toEqual([])
  })
})

describe('retired selections are reported, never re-pointed', () => {
  it('warns once about a selected id the listing dropped and serves it unchanged', async () => {
    const server = await mockServer([], [{
      kind: 'listing',
      body: JSON.stringify({ object: 'list', data: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] }),
    }])
    const { ctx } = await boot({ baseURL: server.url }, { apiKey: 'sk-listing' })
    const warn = warnings(ctx)

    await ids(ctx)
    await settle(server, 1)
    expect(warn).toHaveLength(1)
    expect(warn[0]).toContain('no longer advertises "deepseek-v4-pro"')
    expect(warn[0]).toContain('deepseek-flash')
    expect(warn[0]).toContain('unchanged')

    // The selection keeps working exactly as configured — advisory means
    // advisory — and the report does not repeat per resolution.
    await expect(ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-pro')).resolves.toMatchObject({
      id: 'deepseek-v4-pro',
      name: 'deepseek-v4-pro',
      inputModalities: ['text'],
    })
    await ctx.llm.resolveModelInfo('deepseek-official', 'deepseek-v4-pro')
    expect(warn).toHaveLength(1)
  })
})

describe('settings-surface discovery', () => {
  it('interrogates the draft endpoint with its one-shot credential and stores nothing', async () => {
    const server = await mockServer([], [{ kind: 'listing', body: providerListing }])
    const { ctx } = await boot({ baseURL: 'http://127.0.0.1:1' }, { apiKey: 'sk-listing' })

    await expect(ctx.llm.discoverModels(NS, { baseURL: server.url, apiKey: 'probe-key' }))
      .resolves.toEqual([
        { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash', contextWindow: 1_048_576, maxTokens: 393_216 },
        { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_048_576, maxTokens: 393_216 },
      ])
    expect(server.listingRequests[0]?.headers.authorization).toBe('Bearer probe-key')
    // A probe is not a refresh: what this route serves is untouched, so a
    // configuration surface can never re-point a turn by fetching.
    await expect(ids(ctx)).resolves.toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(server.listingRequests).toHaveLength(1)
  })

  it('falls back to the route credential, and to no credential at all', async () => {
    const server = await mockServer([], [
      { kind: 'listing', body: providerListing },
      { kind: 'listing', body: providerListing },
    ])
    const stored = await boot({ baseURL: server.url }, { dynamic: true })
    await stored.ctx.llm.discoverModels(NS, { baseURL: server.url })
    expect(server.listingRequests[0]?.headers.authorization).toBe('Bearer listing-key')

    const keyless = await boot({ baseURL: server.url }, { apiKey: '' })
    await keyless.ctx.llm.discoverModels(NS, { baseURL: server.url })
    expect(server.listingRequests[1]?.headers.authorization).toBeUndefined()
  })

  it('honors caller cancellation and refuses a reply that is not a listing', async () => {
    const server = await mockServer([], [
      { kind: 'listing', body: '<html>not a listing</html>' },
      { kind: 'listing', body: '<html>not a listing</html>' },
      { kind: 'listing', body: '<html>not a listing</html>' },
    ])
    const { ctx } = await boot({ baseURL: 'http://127.0.0.1:1' }, { apiKey: 'sk-listing' })

    const aborted = new AbortController()
    aborted.abort()
    await expect(ctx.llm.discoverModels(NS, { baseURL: server.url, apiKey: 'probe-key', signal: aborted.signal }))
      .rejects.toMatchObject({ code: 'ABORTED' })
    await expect(ctx.llm.discoverModels(NS, { baseURL: server.url, apiKey: 'probe-key' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_FAILED' })
  })

  it('withdraws the discovery offer with the plugin fiber', async () => {
    const server = await mockServer([], [{ kind: 'listing', body: providerListing }])
    const { ctx, fiber } = await boot({ baseURL: 'http://127.0.0.1:1' }, { apiKey: 'sk-listing' })

    await fiber.dispose()
    await expect(ctx.llm.discoverModels(NS, { baseURL: server.url })).rejects.toMatchObject({ code: 'NO_DISCOVERY' })
  })
})

describe('catalog validation', () => {
  it.each([1.5, -1, Number.MAX_SAFE_INTEGER + 2])(
    'rejects a refresh interval of %s',
    (catalogRefreshMs) => {
      expect(() => LlmDeepSeek.resolveAdapterOptions({ catalogRefreshMs })).toThrow(/catalogRefreshMs/)
    },
  )
})
