/**
 * What the browser half registers: ONE `settings.section`, where it sits in the
 * settings nav, the label both languages ship, and that it all leaves with the
 * fiber.
 *
 * The placement assertions are the ticket's: Learn More sits after General
 * (`order: 0`) and before Plugins (`order: 15`), because it explains the agents
 * a person talks to rather than the deployment's own plumbing.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { LearnInjected } from '../src/client/slots.ts'
import { en, zh } from '../src/client/locales.ts'
import { LEARN_PAYLOAD } from './fixture/learn-payload.client.ts'

/**
 * A client root with the two services the plugin declares, plus a root occupant
 * that declares the settings section hole.
 * @returns the context, the slot registry, and the locale service.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  return { ctx, slots, locale }
}

/** Declare the settings shell's hole, the way ui-settings-general's nav does. */
function declareShell(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-learn apply', () => {
  it('declares the services it reads', () => {
    expect(inject).toStrictEqual(['slots', 'locale'])
  })

  it('registers one Learn More section between General and Plugins', async () => {
    const { ctx, slots } = await bench()
    declareShell(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const entries = slots.entries('settings.section')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.options).toMatchObject({ id: 'learn', order: 5 })
    const order = entries[0]!.options as { order: number }
    expect(order.order).toBeGreaterThan(0)
    expect(order.order).toBeLessThan(15)
  })

  it('labels the tab in the language the page is reading', async () => {
    const { ctx, slots, locale } = await bench()
    declareShell(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const label = slots.entries('settings.section')[0]!.options.label

    // The label is a locale-following thunk: the nav re-reads it on change.
    expect(resolveSlotLabel(label)).toBe(en.nav)
    locale.setLocale('zh')
    expect(resolveSlotLabel(label)).toBe(zh.nav)
    expect(zh.nav).not.toBe(en.nav)
  })

  it('waits for a shell that declares the hole after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(slots.entries('settings.section')).toHaveLength(0)

    declareShell(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('collapses its contribution on teardown', async () => {
    const { ctx, slots } = await bench()
    declareShell(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')).toHaveLength(1)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('hands the section a read of the deployed endpoint', async () => {
    const { ctx, slots } = await bench()
    declareShell(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()
    const calls: string[] = []
    vi.stubGlobal('fetch', (input: string) => {
      calls.push(input)
      return Promise.resolve(new Response(JSON.stringify(LEARN_PAYLOAD), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))
    })
    try {
      const entry = slots.entries('settings.section')[0]!
      const face = (entry.inject as unknown as () => LearnInjected)()
      expect(face.hooks.learn.getSnapshot()).toMatchObject({ status: 'loading', agents: [] })

      face.load()

      await vi.waitFor(() => {
        expect(face.hooks.learn.getSnapshot()).toMatchObject({
          status: 'ready', person: LEARN_PAYLOAD.person,
        })
      })
      // The origin root, not the page's own /_dsh/ prefix: e-server serves it.
      expect(calls).toStrictEqual(['/v1/browser/learn'])
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
