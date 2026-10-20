/** Ownerless-copy registrations: the four seats, dictionaries, and HMR recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '@deepseek-ai/dsh-client-ui-settings-general/client'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'

// These specs assert the shipped Chinese copy. The lane has no jsdom `window`,
// so browser-language detection never runs and a fresh LocaleRuntime opens on
// FALLBACK_LOCALE (en); bench stages zh explicitly on the locale instead.

/** The seats this plugin fills, for a browser on any page authority (FORK-NOTES 17). */
const SEATS = [
  ['settings.trigger', TriggerContent],
  ['settings.header', HeaderContent],
  ['settings.close', CloseLabel],
  ['settings.section', GeneralSection],
] as const

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  ctx.provide('connection', {
    api: { settings: { describe: vi.fn(() => Promise.resolve({ result: { ok: false } })) } },
    isLoopback: true,
  } as never)
  new TestRemote(ctx)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** Declare the shell's five child slots the way ui-settings' entry does. */
function declare(slots: SlotRegistry): () => void {
  return slots.register(
    {
      name: 'root',
      children: {
        'settings.trigger': { kind: 'single', scope: 'root' },
        'settings.header': { kind: 'single', scope: 'root' },
        'settings.close': { kind: 'single', scope: 'root' },
        'settings.section': { kind: 'list', scope: 'root' },
        'settings.onboarding': { kind: 'list', scope: 'root' },
      },
    } as never,
    () => null,
  )
}

function generalEntry(slots: SlotRegistry) {
  return slots.entries('settings.section').find(e => e.component === GeneralSection)
}

describe('ui-settings-general apply', () => {
  it('declares the services it uses', () => {
    // No `connection` and no `settingsScope`: the configuration-file action and
    // its document store were the only readers of the settings wire here.
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('fills every seat for declarations before or after apply', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    for (const [name, component] of SEATS) {
      expect(before.slots.entries(name)[0]!.component).toBe(component)
    }
    const entry = generalEntry(before.slots)!
    expect(entry.options).toMatchObject({ id: 'general', order: 0 })
    expect(before.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    expect(before.slots.entries('settings.general.item')).toEqual([])
    // The onboarding hole stays declared for feature-owned steps; this plugin
    // no longer seats one.
    expect(before.slots.entries('settings.onboarding')).toEqual([])
    // Copy rides the standard locale seat: every seat declares the namespace.
    for (const [name] of SEATS) {
      expect(before.slots.entries(name)[0]!.locale).toBe('settings')
    }
    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const [name] of SEATS) expect(after.slots.entries(name)).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    for (const [name, component] of SEATS) {
      expect(after.slots.entries(name)[0]!.component).toBe(component)
      // The self-inflicted ledger notifications hit the duplicate guard.
      expect(after.slots.entries(name)).toHaveLength(1)
    }
    await vi.waitFor(() => {
      expect(after.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    })
  })

  it('registers the zh/en settings dictionaries and frees the seats on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.locale.bind('settings')('title')).toBe('设置')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings')('close')).toBe('Close')
    b.locale.setLocale('zh')
    await fiber.dispose()
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => b.locale.register('settings', 'zh', {})).not.toThrow()
    expect(() => b.locale.register('settings', 'en', {})).not.toThrow()
  })

  it('registers no section label: the panel renders one section and captions nothing', async () => {
    // The nav rail is gone (the household asked for the tabs gone), so a section
    // label would be copy no surface reads.
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(generalEntry(b.slots)!.options.label).toBeUndefined()
  })

  it('re-registers after an HMR collapse of the declaring chain (stale disposers must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    // Declarer unload: the cascade removes every seat entry and the item
    // declaration while our local disposers go stale.
    redeclare()
    for (const [name] of SEATS) expect(b.slots.entries(name)).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
    declare(b.slots)
    await Promise.resolve()
    for (const [name, component] of SEATS) {
      expect(b.slots.entries(name)[0]!.component).toBe(component)
    }
    expect(b.slots.entries('settings.general.item')).toEqual([])
    expect(b.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    // The recovered registrations still ride the locale path.
    expect(b.locale.bind('settings')('title')).toBe('设置')
    b.locale.setLocale('en')
    expect(b.locale.bind('settings')('title')).toBe('Settings')
    b.locale.setLocale('zh')
  })

  it('removes every seat and the item declaration on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(b.slots.spec('settings.general.item')).toBeDefined()
    await fiber.dispose()
    for (const [name] of SEATS) expect(b.slots.entries(name)).toHaveLength(0)
    expect(b.slots.spec('settings.general.item')).toBeUndefined()
  })
})
