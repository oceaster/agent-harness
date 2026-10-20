/**
 * Registration: the session-header label is the package's one contribution,
 * it defers until the slot it fills has been declared, and a preset committed
 * in another tab lands in the session row the label reads.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-agent-preset/client'
import { AgentPresetLabel } from '../src/client/AgentPresetLabel.tsx'
import type { AgentPresetLabelInjected } from '../src/client/AgentPresetLabel.tsx'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); each bench stages zh explicitly on the locale instead.

const ROSTER_ONE = {
  rpcId: 'r',
  result: {
    ok: true as const,
    value: {
      presets: [{ id: 'standard', trust: 'system', isDefault: true }],
      authorable: false,
      hasDocument: false,
    },
  },
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  // The plugin injects `remote`; forwarded events reach it through the same
  // `$dispatch` handoff the connection sink makes.
  new TestRemote(ctx)
  const calls: string[] = []
  ctx.provide('connection', {
    api: {
      agentPresets: {
        list: () => { calls.push('list'); return Promise.resolve(ROSTER_ONE) },
      },
    },
  } as never)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, calls }
}

/**
 * The shell's root seat, which the conversation mounts under. It also declares
 * the two Settings seats the package no longer fills, so a registration that
 * came back would land and be seen here rather than wait for a declaration
 * that never arrives.
 */
function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      conversation: { kind: 'single', scope: 'root' },
      'settings.general.item': { kind: 'list', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

/** The conversation's own declaration, which the label waits for. */
function declareConversation(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'conversation',
    children: {
      'conversation.session.header.mode': { kind: 'single', scope: 'session' },
    },
  } as never, () => null)
}

/** A sessions double whose row a forwarded commit can move. */
function sessionsDouble(state: { current?: string; byId: Record<string, { id: string; blank: boolean; agentPreset?: string }> }) {
  const listeners = new Set<() => void>()
  return {
    list: {
      getSnapshot: () => state,
      subscribe: (fn: () => void) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    noteAgentPreset: (sessionId: string, agentPreset: string) => {
      const summary = state.byId[sessionId]
      if (summary === undefined || summary.agentPreset === agentPreset) return
      summary.agentPreset = agentPreset
      for (const fn of listeners) fn()
    },
  }
}

describe('ui-agent-preset apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'sessions'])
  })

  it('registers the header label and nothing else', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const label = slots.entries('conversation.session.header.mode')[0]!
    expect(label.component).toBe(AgentPresetLabel)
    // The roster-managing tab and the default-setting row are gone: a family
    // member picks an agent from the inbox row, not from Settings.
    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.entries('settings.general.item')).toHaveLength(0)
    expect(slots.entries('conversation.hero.agentPreset')).toHaveLength(0)
  })

  it('registers into a declaration that arrives after apply, and drops it on disposal', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    declareConversation(slots)

    await vi.waitFor(() => { expect(slots.entries('conversation.session.header.mode')).toHaveLength(1) })
    await fiber.dispose()
    expect(slots.entries('conversation.session.header.mode')).toHaveLength(0)
  })

  it('hands the label a roster loader and store', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    declareConversation(slots)
    ctx.provide('sessions', sessionsDouble({ byId: {} }) as never)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const label = (slots.entries('conversation.session.header.mode')[0]!
      .inject as unknown as () => AgentPresetLabelInjected)()

    await label.load()

    expect(label.hooks.agentPresets.getSnapshot().options).toEqual([{ id: 'standard', trust: 'system' }])
  })

  it('folds a preset committed in another tab into the shared session row', async () => {
    const { ctx } = await bench()
    const state = {
      current: 's1',
      byId: { s1: { id: 's1', blank: true, agentPreset: 'standard' } },
    }
    ctx.provide('sessions', sessionsDouble(state) as never)
    await ctx.plugin({ inject: [...inject], apply }).await()

    ctx.remote.$dispatch('agent-preset/selected', ['s1', 'minimal'])

    // The row is what the label renders, so a switch made elsewhere reaches it.
    expect(state.byId.s1.agentPreset).toBe('minimal')
  })
})
