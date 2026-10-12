import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  installModelSelection,
  resolveAgentDefaultModel,
  type Agent,
  type ModelSelectionRef,
} from '../src/index.ts'
import { ReasoningEffortId, type LlmCallConfig } from '@deepseek-ai/dsh-llm'

describe('installModelSelection()', () => {
  it('snapshots prompt variables and request routing together, then disposes both listeners', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const selection: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx, selection)
    const agent = {} as Agent
    const seed: LlmCallConfig = { provider: 'seed', model: 'seed', temperature: 0.2 }
    const signal = new AbortController().signal

    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    selection.current = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
    }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'alpha', model: 'a1' })
    selection.current = { provider: 'beta', model: 'b1' }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('high'),
      temperature: 0.2,
    })

    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({ provider: 'beta', model: 'b1' })
    const inherited: LlmCallConfig = {
      provider: 'alpha',
      model: 'a1',
      reasoningEffort: ReasoningEffortId('max'),
      temperature: 0.2,
    }
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({ provider: 'beta', model: 'b1', temperature: 0.2 })

    dispose()
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)
    await ctx.fiber.dispose()
  })
})

describe('composition defaults and delegated selections', () => {
  it('uses the composition default and removes it when the contribution disposes', async () => {
    const ctx = new Context()
    const agent = { id: 'preset-agent', ctx, options: {} } as unknown as Agent
    const fallback = { provider: 'cloud', model: 'flash' }
    expect(resolveAgentDefaultModel(agent, fallback)).toBe(fallback)
    const dispose = ctx.on('agent/default-model', () => ({
      provider: 'cloud', model: 'pro', reasoningEffort: ReasoningEffortId('max'),
    }))
    expect(resolveAgentDefaultModel(agent, fallback)).toMatchObject({ model: 'pro', reasoningEffort: 'max' })
    dispose()
    expect(resolveAgentDefaultModel(agent, fallback)).toBe(fallback)
    await ctx.fiber.dispose()
  })

  it('updates the route inherited by workers at the same assembly boundary as a model switch', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const agent = { id: 'selected-agent', ctx, options: {} } as unknown as Agent
    Object.defineProperty(ctx, 'agent', { value: agent })
    const selection: ModelSelectionRef = {
      current: { provider: 'cloud', model: 'pro', reasoningEffort: ReasoningEffortId('max') },
      assembled: undefined,
    }
    installModelSelection(ctx, selection)
    await ctx.systemPrompt.assemble()
    expect(agent.options).toMatchObject({ provider: 'cloud', model: 'pro', reasoningEffort: 'max' })
    selection.current = { provider: 'local', model: 'dexter' }
    await ctx.systemPrompt.assemble()
    expect(agent.options).toEqual({ provider: 'local', model: 'dexter' })
    await ctx.fiber.dispose()
  })
})
