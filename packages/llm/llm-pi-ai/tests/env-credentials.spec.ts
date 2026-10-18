/**
 * Provider-scoped environment: the `env` and `envCredentials` profile fields,
 * their config validation, and the path by which a resolved credential reaches
 * pi-ai. A route that signs with SigV4 (Amazon Bedrock) needs a region plus two
 * secrets, none of which can ride pi-ai's single `apiKey` option — that one is
 * a bearer token — so these values travel as the stream's `env` option, which
 * pi-ai's provider implementations and their ambient credential discovery read
 * ahead of `process.env`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai'
import type { PiAiAdapterOptions } from '@deepseek-ai/dsh-llm-pi-ai'
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai'
import type { Api, AssistantMessageEventStream, Model, Provider, SimpleStreamOptions } from '@earendil-works/pi-ai'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { assertServiceable, Config, resolveProfiles } from '../src/config.ts'
import type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from '../src/config.ts'
import { assemble } from './assemble.ts'
import { closeMockServers, mockServer } from './mock-server.ts'

/**
 * The environment name these tests deliver through. pi-ai's `openai` catalog
 * provider resolves its own key from `OPENAI_API_KEY` through the environment
 * context that `Models` overlays with the request's `env`, so the
 * `Authorization` header on a mock request is direct evidence that a value the
 * harness resolved reached pi-ai. A Bedrock route would prove the same delivery
 * only by signing a real request, and an AWS access key never appears in a
 * request body at all.
 */
const DELIVERED_ENV_NAME = 'OPENAI_API_KEY'

/** The credential reference that route names instead of the value above. */
const DELIVERED_REF = 'PI_ENV_CREDENTIAL_REF'

/** A model the installed Amazon Bedrock catalog ships. */
const BEDROCK_MODEL = 'amazon.nova-lite-v1:0'

beforeEach(() => {
  // Credentials in this file come from the seams under test; an ambient key
  // must not be able to mask a missing reference.
  vi.stubEnv('OPENAI_API_KEY', '')
})

afterEach(async () => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  await closeMockServers()
})

/** One complete pi-ai turn, so a recorded call runs the real adapter path. */
function recordedTurn(model: Model<Api>): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const message = {
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'recorded' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop' as const,
    timestamp: 0,
  }
  stream.push({ type: 'done', reason: 'stop', message })
  stream.end(message)
  return stream
}

/**
 * A pi-ai provider that records every option set the adapter hands it.
 * @param base - the provider `resolveProfiles` built for the route.
 * @param calls - the list each stream call appends its options to.
 * @returns the recording provider.
 */
function recordingProvider(base: Provider, calls: SimpleStreamOptions[]): Provider {
  return {
    ...base,
    streamSimple: (model, _context, options) => {
      calls.push(options ?? {})
      return recordedTurn(model)
    },
  }
}

/** One adapter over `providers`, with the option sets its pi-ai providers received. */
function recordingAdapter(
  providers: Record<string, PiAiProviderProfile>,
  hooks: Partial<Pick<PiAiAdapterOptions, 'resolveApiKey' | 'resolveEnvCredentials'>> = {},
): { adapter: PiAiAdapter; calls: SimpleStreamOptions[] } {
  const calls: SimpleStreamOptions[] = []
  const profiles = resolveProfiles(providers)
  for (const [provider, profile] of profiles) {
    profiles.set(provider, { ...profile, piProvider: recordingProvider(profile.piProvider, calls) })
  }
  return {
    calls,
    adapter: new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: hooks.resolveApiKey ?? (() => Promise.resolve(undefined)),
      ...hooks.resolveEnvCredentials === undefined ? {} : { resolveEnvCredentials: hooks.resolveEnvCredentials },
    }),
  }
}

/** Run one stream call to completion; the recorded option set is the assertion target. */
async function drain(
  adapter: PiAiAdapter,
  options: Omit<GenerateOptions, 'provider'> & { provider?: string },
): Promise<void> {
  for await (const _chunk of adapter.stream({ provider: 'openai', ...options })) { /* drain */ }
}

/** A harness whose credential seam is the in-memory provider, seeded from `seed`. */
async function credentialsHarness(
  baseURL: string,
  profile: PiAiProviderProfile,
  seed: Record<string, string>,
): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemoryCredentials, seed)
  await ctx.plugin(LlmPiAi, { providers: { openai: { baseURL: `${baseURL}/v1`, ...profile } } })
  return ctx
}

/** Every invalid provider-scoped env this schema boundary must refuse. */
const invalidEnvs: [string, PiAiProviderProfile, RegExp][] = [
  ['a malformed env name', { env: { 'AWS-REGION': 'us-east-1' } }, /provider "amazon-bedrock" env key "AWS-REGION"/],
  ['an empty env name', { env: { '': 'us-east-1' } }, /provider "amazon-bedrock" env key ""/],
  ['a digit-leading envCredentials name', { envCredentials: { '2AWS_REGION': 'A_REF' } }, /envCredentials key "2AWS_REGION"/],
  ['an empty env value', { env: { AWS_REGION: '' } }, /provider "amazon-bedrock" env "AWS_REGION" is empty/],
  [
    'a malformed credential reference',
    { envCredentials: { AWS_ACCESS_KEY_ID: 'not a variable' } },
    /provider "amazon-bedrock" envCredentials "AWS_ACCESS_KEY_ID" must be a credential reference/,
  ],
]

describe('provider-scoped env configuration', () => {
  it('accepts plain values and credential references, keeping the references only', () => {
    const profile = resolveProfiles({
      'amazon-bedrock': {
        env: { AWS_REGION: 'us-east-1' },
        envCredentials: { AWS_ACCESS_KEY_ID: 'BEDROCK_ACCESS_KEY_ID', AWS_SECRET_ACCESS_KEY: 'BEDROCK_SECRET_KEY' },
      },
    }).get('amazon-bedrock')
    expect(profile?.env).toEqual({ AWS_REGION: 'us-east-1' })
    expect(profile?.envCredentials).toEqual({
      AWS_ACCESS_KEY_ID: credentialRef('BEDROCK_ACCESS_KEY_ID'),
      AWS_SECRET_ACCESS_KEY: credentialRef('BEDROCK_SECRET_KEY'),
    })
  })

  it('treats an absent and an empty dict alike', () => {
    // The schema materializes `{}` for an absent dict, so both spellings reach
    // resolution; neither may leave a key that would send an empty `env`.
    const materialized = Config({ providers: { 'amazon-bedrock': { env: {}, envCredentials: {} } } })
    for (const profile of resolveProfiles(materialized.providers).values()) {
      expect('env' in profile).toBe(false)
      expect('envCredentials' in profile).toBe(false)
    }
    const absent = resolveProfiles({ 'amazon-bedrock': {} }).get('amazon-bedrock')
    if (absent === undefined) throw new Error('the amazon-bedrock route did not resolve')
    expect(Object.hasOwn(absent, 'env')).toBe(false)
    expect(Object.hasOwn(absent, 'envCredentials')).toBe(false)
  })

  it('copies a declared dict out of the configuration object', () => {
    const source = { env: { AWS_REGION: 'us-east-1' } }
    const profile = resolveProfiles({ 'amazon-bedrock': source }).get('amazon-bedrock')
    expect(profile?.env).toEqual({ AWS_REGION: 'us-east-1' })
    expect(profile?.env).not.toBe(source.env)
  })

  it.each(invalidEnvs)('refuses %s, naming the route and the key', (_label, profile, expected) => {
    expect(() => resolveProfiles({ 'amazon-bedrock': profile })).toThrow(expected)
  })

  it('refuses one name declared by both dicts instead of resolving it twice', () => {
    expect(() => resolveProfiles({
      'amazon-bedrock': {
        env: { AWS_ACCESS_KEY_ID: 'plain-value' },
        envCredentials: { AWS_ACCESS_KEY_ID: 'BEDROCK_ACCESS_KEY_ID' },
      },
    })).toThrow(/provider "amazon-bedrock" declares env var "AWS_ACCESS_KEY_ID" in both env and envCredentials/)
  })

  it('refuses an unserviceable env at the settings write that would store it', () => {
    // The pair the settings seam runs: the schema accepts the dicts as
    // well-typed, and the namespace validator is what names the offending key.
    const section = Config({ providers: { 'amazon-bedrock': { env: { 'AWS REGION': 'us-east-1' } } } })
    expect(() => { assertServiceable(section) })
      .toThrow(/provider "amazon-bedrock" env key "AWS REGION"/)
  })

  it('refuses an unserviceable env at plugin load', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await expect(ctx.plugin(LlmPiAi, {
      providers: { 'amazon-bedrock': { env: { AWS_REGION: '' } } },
    })).rejects.toThrow(/provider "amazon-bedrock" env "AWS_REGION" is empty/)
    expect(ctx.llm.listProviders()).toEqual([])
  })
})

describe('provider-scoped env delivery to pi-ai', () => {
  it('hands pi-ai one env option carrying the plain values and the resolved credentials', async () => {
    const { adapter, calls } = recordingAdapter({
      'amazon-bedrock': {
        env: { AWS_REGION: 'us-east-1', AWS_DEFAULT_REGION: 'us-east-1' },
        envCredentials: { AWS_ACCESS_KEY_ID: 'BEDROCK_ACCESS_KEY_ID', AWS_SECRET_ACCESS_KEY: 'BEDROCK_SECRET_KEY' },
      },
    }, {
      // Both halves of the SigV4 pair: pi-ai's Bedrock auth resolves from the
      // delivered environment alone, which is what lets this reach the
      // provider at all — the assertion below then shows the values it read.
      resolveEnvCredentials: () => Promise.resolve({
        AWS_ACCESS_KEY_ID: 'AKIA-RESOLVED',
        AWS_SECRET_ACCESS_KEY: 'resolved-secret',
      }),
    })

    await drain(adapter, { provider: 'amazon-bedrock', model: BEDROCK_MODEL, messages: [] })

    expect(calls).toHaveLength(1)
    expect(calls[0]?.env).toEqual({
      AWS_REGION: 'us-east-1',
      AWS_DEFAULT_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIA-RESOLVED',
      AWS_SECRET_ACCESS_KEY: 'resolved-secret',
    })
  })

  it('lets a resolved credential win over a plain value of the same name', async () => {
    // Config resolution refuses one name in both dicts, so this pairing is
    // reachable only by construction — and the precedence must still hold,
    // because a value every configuration surface can read must never be what
    // the route signs with once the same name is also given a reference.
    const resolved = resolveProfiles({ openai: { env: { [DELIVERED_ENV_NAME]: 'plain-value' } } }).get('openai')
    if (resolved === undefined) throw new Error('the openai route did not resolve')
    const calls: SimpleStreamOptions[] = []
    const profiles = new Map<string, ResolvedPiAiProviderProfile>([['openai', {
      ...resolved,
      envCredentials: { [DELIVERED_ENV_NAME]: credentialRef(DELIVERED_REF) },
      piProvider: recordingProvider(resolved.piProvider, calls),
    }]])
    const adapter = new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: () => Promise.resolve(undefined),
      resolveEnvCredentials: () => Promise.resolve({ [DELIVERED_ENV_NAME]: 'resolved-secret' }),
    })

    await drain(adapter, { model: 'gpt-4.1', messages: [] })

    expect(calls[0]?.env).toEqual({ [DELIVERED_ENV_NAME]: 'resolved-secret' })
  })

  it('delivers no env override for a route that declares neither field', async () => {
    // The promise of unchanged behavior: pi-ai sees no environment override
    // from this adapter. `Models` always materializes the key on the provider's
    // options (as undefined), so the assertion is on the value — a route that
    // declares neither field must leave pi-ai's own environment lookup in
    // charge. The key override stands in for the `apiKeyEnv` half of a real
    // catalog route, so this test is about `env` and nothing else.
    const { adapter, calls } = recordingAdapter(
      { openai: {} },
      { resolveApiKey: () => Promise.resolve('recorded-key') },
    )
    await drain(adapter, { model: 'gpt-4.1', messages: [] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.env).toBeUndefined()
  })

  it('resolves the route\'s references once per stream call', async () => {
    const resolveEnvCredentials = vi.fn(
      (_provider: string, _profile: ResolvedPiAiProviderProfile) => Promise.resolve({ AWS_ACCESS_KEY_ID: 'AKIA-ONE' }),
    )
    const { adapter } = recordingAdapter({
      'amazon-bedrock': { envCredentials: { AWS_ACCESS_KEY_ID: 'BEDROCK_ACCESS_KEY_ID' } },
    }, { resolveEnvCredentials })

    await drain(adapter, { provider: 'amazon-bedrock', model: BEDROCK_MODEL, messages: [] })
    await drain(adapter, { provider: 'amazon-bedrock', model: BEDROCK_MODEL, messages: [] })

    // Per request, not per configuration: a rotated credential reaches the
    // next call without re-registering anything.
    expect(resolveEnvCredentials).toHaveBeenCalledTimes(2)
    expect(resolveEnvCredentials.mock.calls[0]?.[0]).toBe('amazon-bedrock')
    expect(resolveEnvCredentials.mock.calls[0]?.[1].envCredentials)
      .toEqual({ AWS_ACCESS_KEY_ID: credentialRef('BEDROCK_ACCESS_KEY_ID') })
  })
})

describe('envCredentials resolution seam', () => {
  it('resolves each reference through the credentials seam and delivers it to pi-ai', async () => {
    const server = await mockServer([{ status: 401, body: '{}' }])
    const ctx = await credentialsHarness(
      server.url,
      { envCredentials: { [DELIVERED_ENV_NAME]: DELIVERED_REF } },
      { [DELIVERED_REF]: 'sk-from-credentials' },
    )

    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    // The mock refuses the request; what matters is which value authenticated it.
    expect(result.finish.kind).toBe('error')
    expect(server.paths).toEqual(['/v1/responses'])
    expect(server.headers[0]?.authorization).toBe('Bearer sk-from-credentials')
  })

  it('delivers a plain env value to pi-ai too', async () => {
    const server = await mockServer([{ status: 401, body: '{}' }])
    const ctx = await credentialsHarness(server.url, { env: { [DELIVERED_ENV_NAME]: 'plain-env-value' } }, {})

    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    expect(server.headers[0]?.authorization).toBe('Bearer plain-env-value')
  })

  it('falls back to the launch environment for a reference without the credentials seam', async () => {
    vi.stubEnv(DELIVERED_REF, 'sk-from-launch-environment')
    const server = await mockServer([{ status: 401, body: '{}' }])
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(LlmPiAi, {
      providers: { openai: { baseURL: `${server.url}/v1`, envCredentials: { [DELIVERED_ENV_NAME]: DELIVERED_REF } } },
    })

    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    expect(server.headers[0]?.authorization).toBe('Bearer sk-from-launch-environment')
  })

  it('re-resolves a rotated credential for every request', async () => {
    const server = await mockServer([{ status: 401, body: '{}' }, { status: 401, body: '{}' }])
    const ctx = await credentialsHarness(
      server.url,
      { envCredentials: { [DELIVERED_ENV_NAME]: DELIVERED_REF } },
      { [DELIVERED_REF]: 'sk-first' },
    )
    const resolve = vi.spyOn(ctx.credentials, 'resolve')

    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
    await ctx.credentials.set(credentialRef(DELIVERED_REF), 'sk-rotated')
    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    expect(resolve).toHaveBeenCalledTimes(2)
    expect(server.headers.map(headers => headers.authorization))
      .toEqual(['Bearer sk-first', 'Bearer sk-rotated'])
  })

  it.each([
    ['missing from the credential store', 'sk-ignored', false],
    ['blank in the launch environment', '', true],
  ])('fails a reference %s instead of signing with an ambient credential', async (_label, stored, withoutSeam) => {
    // The exact confusion this guards: the named reference supplies nothing
    // while an unrelated ambient key sits in the environment, which is what
    // pi-ai's own environment fallback would pick up — authenticating the
    // route as some other identity than the one the deployment configured.
    vi.stubEnv(DELIVERED_ENV_NAME, 'ambient-key')
    vi.stubEnv(DELIVERED_REF, stored)
    const server = await mockServer([])
    const ctx = withoutSeam
      ? new Context()
      : await credentialsHarness(server.url, { envCredentials: { [DELIVERED_ENV_NAME]: DELIVERED_REF } }, {})
    if (withoutSeam) {
      await ctx.plugin(LlmRuntime)
      await ctx.plugin(LlmPiAi, {
        providers: { openai: { baseURL: `${server.url}/v1`, envCredentials: { [DELIVERED_ENV_NAME]: DELIVERED_REF } } },
      })
    }

    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    expect(result.finish).toMatchObject({ kind: 'error', failure: { code: 'MISSING_CREDENTIAL' } })
    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    expect(result.finish.failure.message)
      .toMatch(/provider route "openai".*OPENAI_API_KEY from PI_ENV_CREDENTIAL_REF/s)
    expect(server.requests).toHaveLength(0)
  })

  it('never puts a resolved secret value in the failure it reports', async () => {
    const secret = 'AKIA-do-not-echo-this-value'
    const server = await mockServer([])
    const ctx = await credentialsHarness(server.url, {
      envCredentials: { AWS_ACCESS_KEY_ID: 'PI_PRESENT_KEY_REF', AWS_SECRET_ACCESS_KEY: 'PI_MISSING_KEY_REF' },
    }, { PI_PRESENT_KEY_REF: secret })

    const result = await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })

    if (result.finish.kind !== 'error') throw new Error('expected an error finish')
    // The message names what is missing — the reference — and none of what the
    // route's other, successfully resolved secrets hold.
    expect(result.finish.failure).toMatchObject({ code: 'MISSING_CREDENTIAL' })
    expect(result.finish.failure.message).toMatch(/AWS_SECRET_ACCESS_KEY from PI_MISSING_KEY_REF/)
    expect(result.finish.failure.message).not.toContain(secret)
    expect(server.requests).toHaveLength(0)
  })

  it('keeps the credential out of every RPC-visible payload', async () => {
    const secret = 'AKIA-only-in-the-credential-store'
    const profile = { envCredentials: { [DELIVERED_ENV_NAME]: DELIVERED_REF } }
    const server = await mockServer([])
    const ctx = await credentialsHarness(server.url, profile, { [DELIVERED_REF]: secret })

    // The settings section a configuration surface reads, and the profile the
    // adapter resolves, both carry the reference alone.
    const section = Config({ providers: { openai: profile } })
    expect(JSON.stringify(section)).not.toContain(secret)
    expect(JSON.stringify(resolveProfiles(section.providers).get('openai'))).not.toContain(secret)
    expect(resolveProfiles(section.providers).get('openai')?.envCredentials)
      .toEqual({ [DELIVERED_ENV_NAME]: credentialRef(DELIVERED_REF) })

    // ...and the live route still serves from that reference, so the value
    // exists only for the duration of one request.
    await assemble(ctx, { provider: 'openai', model: 'gpt-4.1', messages: [] })
  })
})
