/**
 * What the browser half registers, and that it all leaves with the fiber.
 *
 * The section is a read-only window: it publishes the Plugins navigation entry
 * and declares the tab slot other plugins contribute pages into, and publishes
 * nothing a reader could write a setting through.
 */

import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'
import type { PluginsSettingsSectionInjected } from '@deepseek-ai/dsh-client-ui-settings-plugins/client'

/**
 * A bench with the two services the plugin injects. No settings scope and no
 * Remote: a surface that writes nothing has nothing to bind them to.
 */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

function declareRoot(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'settings.section': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-settings-plugins apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers one Plugins section and declares the tab slot', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    expect(section.options).toMatchObject({ id: 'plugins', order: 15 })
    // The nav label is a locale-following thunk; owners resolve it at read time.
    expect(resolveSlotLabel(section.options.label)).toBe('插件')
    expect(slots.spec('settings.plugins.tab')).toMatchObject({ kind: 'list', scope: 'root' })
  })

  it('contributes no page of its own and declares no card slot', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)

    await ctx.plugin({ inject: [...inject], apply }).await()

    // Nothing in this package is a `settings.plugins.tab` entry any more: the
    // configurable page and its cards are deleted, not flag-hidden.
    expect(slots.entries('settings.plugins.tab')).toHaveLength(0)
    // The keyed card slot is gone from the slot map entirely. `spec` is typed
    // against SlotMap, so naming a retired key needs the widening cast.
    const specOf = slots.spec.bind(slots) as (name: string) => unknown
    expect(specOf('settings.plugin.item')).toBeUndefined()
  })

  it('projects the pages other plugins contribute, in order', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    await ctx.plugin({ inject: [...inject], apply }).await()

    const section = slots.entries('settings.section')[0]!
    const face = (section.inject as unknown as () => PluginsSettingsSectionInjected)()
    expect(face.hooks.tabs.getSnapshot()).toEqual([])

    slots.register({ name: 'settings.plugins.tab', id: 'all', order: 10, label: 'Plugin list' } as never, () => null)

    const projected = face.hooks.tabs.getSnapshot()
    expect(projected).toEqual([{ id: 'all', order: 10, label: 'Plugin list' }])
    // An unchanged ledger keeps its snapshot identity (reactive rule 5).
    expect(face.hooks.tabs.getSnapshot()).toBe(projected)

    const listener = vi.fn()
    const unsubscribe = face.hooks.tabs.subscribe(listener)
    slots.register({ name: 'settings.plugins.tab', id: 'plain' } as never, () => null)
    expect(face.hooks.tabs.getSnapshot()).toEqual([
      { id: 'plain', order: 0, label: '' },
      { id: 'all', order: 10, label: 'Plugin list' },
    ])
    await vi.waitFor(() => { expect(listener).toHaveBeenCalled() })
    unsubscribe()
  })

  it('re-projects when the locale changes, and follows a declarer reload', async () => {
    const { ctx, slots, locale } = await bench()
    const stop = declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const listener = vi.fn()
    const face = (slots.entries('settings.section')[0]!.inject as unknown as () => PluginsSettingsSectionInjected)()
    face.hooks.tabs.subscribe(listener)
    locale.setLocale('en')
    await vi.waitFor(() => { expect(listener).toHaveBeenCalled() })

    stop()
    expect(slots.entries('settings.section')).toHaveLength(0)
    declareRoot(slots)
    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })

    await fiber.dispose()
    expect(slots.entries('settings.section')).toHaveLength(0)
  })

  it('registers into a declaration that arrives after apply', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()

    declareRoot(slots)

    await vi.waitFor(() => { expect(slots.entries('settings.section')).toHaveLength(1) })
  })

  it('collapses every contribution on teardown', async () => {
    const { ctx, slots } = await bench()
    declareRoot(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('settings.section')).toHaveLength(1)

    await fiber.dispose()

    expect(slots.entries('settings.section')).toHaveLength(0)
    expect(slots.spec('settings.plugins.tab')).toBeUndefined()
  })
})
