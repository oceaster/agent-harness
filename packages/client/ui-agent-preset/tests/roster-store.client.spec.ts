/**
 * The roster reader behind the header label: one `agentPreset.list` call
 * answers the display copy, a broken preset carries none, and an empty or
 * failed roster reads as "nothing to name" rather than as an error to render.
 */

import { describe, expect, it } from 'vitest'
import type { IApiClient } from '@deepseek-ai/dsh-api-remotes/client'
import { AgentPresetRosterController } from '../src/client/roster-store.ts'

/** A client whose roster and refusal the test controls. */
function fakeApi(
  presets: { id: string; trust: 'system' | 'user'; isDefault: boolean; name?: string; description?: string; broken?: string }[],
  options: { failList?: string; rejectList?: Error } = {},
): IApiClient {
  return {
    agentPresets: {
      list: () => {
        if (options.rejectList !== undefined) return Promise.reject(options.rejectList)
        return Promise.resolve(options.failList === undefined
          ? { rpcId: 'r', result: { ok: true as const, value: { presets, authorable: false, hasDocument: false } } }
          : { rpcId: 'r', result: { ok: false as const, error: { code: 'internal', message: options.failList, details: {} } } })
      },
    },
  } as unknown as IApiClient
}

describe('the agent-preset roster reader', () => {
  it('derives the display copy of every composed preset from one roster call', async () => {
    const controller = new AgentPresetRosterController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'mine', trust: 'user', isDefault: false },
    ]))

    await controller.load()

    const state = controller.store.getSnapshot()
    expect(state.status).toBe('ready')
    expect(state.options).toEqual([
      { id: 'standard', trust: 'system' },
      { id: 'mine', trust: 'user' },
    ])
  })

  it('reads a broken preset as having no display copy', async () => {
    const controller = new AgentPresetRosterController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
      { id: 'damaged', trust: 'user', isDefault: false, broken: 'the composition is not valid YAML' },
    ]))

    await controller.load()

    // A preset that failed to load published no name to show; the label falls
    // back to the id the session recorded.
    expect(controller.store.getSnapshot().options.map(option => option.id)).toEqual(['standard'])
  })

  it('carries the display metadata a preset published', async () => {
    const controller = new AgentPresetRosterController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true, name: '标准模式', description: '完整的编码 agent。' },
    ]))

    await controller.load()

    expect(controller.store.getSnapshot().options).toEqual([
      { id: 'standard', trust: 'system', name: '标准模式', description: '完整的编码 agent。' },
    ])
  })

  it('reports an empty roster as unavailable rather than as a state to render', async () => {
    const controller = new AgentPresetRosterController(fakeApi([]))

    await controller.load()

    // A deployment composing no presets is valid: every session shares the
    // host composition and the label names nothing.
    expect(controller.store.getSnapshot()).toEqual({ status: 'unavailable', options: [] })
  })

  it.each([
    ['an ok:false envelope', { failList: 'roster unavailable' }],
    ['a rejected transport', { rejectList: new Error('connection lost') }],
  ])('leaves nothing to name after %s', async (_label, refusal) => {
    const controller = new AgentPresetRosterController(fakeApi([
      { id: 'standard', trust: 'system', isDefault: true },
    ], refusal))

    await controller.load()

    // Naming a preset from a failed read would show copy the host no longer
    // confirms; the label falls back to the session's own recorded id.
    expect(controller.store.getSnapshot()).toEqual({ status: 'unavailable', options: [] })
  })

  it('collapses a second load into the one already in flight', async () => {
    let calls = 0
    const api = {
      agentPresets: {
        list: () => {
          calls += 1
          return Promise.resolve({
            rpcId: 'r',
            result: { ok: true as const, value: { presets: [{ id: 'standard', trust: 'system', isDefault: true }], authorable: false, hasDocument: false } },
          })
        },
      },
    } as unknown as IApiClient
    const controller = new AgentPresetRosterController(api)

    await Promise.all([controller.load(), controller.load(), controller.load()])

    // Several headers mount at once and each asks for the same answer.
    expect(calls).toBe(1)
  })
})
