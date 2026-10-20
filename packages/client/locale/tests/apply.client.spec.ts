/** locale apply wiring: service + base dictionary provision, the absence of a
 * settings row (the plugin owns no settings surface), and the Host preference
 * the assembled app adopts after nonblocking activation. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject } from '@deepseek-ai/dsh-client-locale/client'
import type { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '../src/locale-settings.ts'

const SLOT = 'settings.general.item'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  let preference: string | undefined
  let revision = 0
  const namespace = () => ({
    ns: LOCALE_SETTINGS_NAMESPACE,
    schema: LocaleSettingsSchema.toJSON(),
    value: preference === undefined ? {} : { preference },
    applies: 'live' as const,
    secrets: [],
    revision,
  })
  const describe = vi.fn(async () => ({
    rpcId: 'locale-describe' as never,
    result: {
      ok: true as const,
      value: { writable: true, hasDocument: true, namespaces: [namespace()] },
    },
  }))
  const mutate = vi.fn(async (request: { ops: { value: string }[] }) => {
    preference = request.ops[0]!.value
    revision += 1
    return {
      rpcId: 'locale-mutate' as never,
      result: { ok: true as const, value: namespace() },
    }
  })
  ctx.provide('connection', { api: { settings: { describe, mutate } }, isLoopback: true } as never)
  // The settings transport and the forwarded-event port the plugin injects.
  new TestRemote(ctx)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return {
    ctx, slots: ctx.get('slots') as SlotRegistry, describe, mutate,
    setHostPreference: (next: string | undefined) => { preference = next; revision += 1 },
  }
}

/** Stand in for the settings shell: declare the General item slot from root. */
function declareItems(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { [SLOT]: { kind: 'list', scope: 'root' } } } as never,
    () => null,
  )
}

describe('locale apply', () => {
  // These are wiring specs, not default-language specs. A fresh LocaleRuntime
  // with no jsdom `window` skips browser detection and opens on FALLBACK_LOCALE
  // (en); each test that needs another locale stages it explicitly through
  // setLocale or the Host preference instead of leaning on a dead browser pin.

  it('declares the slot service', () => {
    expect(inject).toEqual(['slots', 'connection', 'remote', 'settingsScope'])
  })

  it('provides the service with the base dictionaries and contributes no settings row', async () => {
    const b = await bench()
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = b.ctx.get('locale') as LocaleRuntime
    // Base dictionaries are registered: the (ns, locale) seats are occupied.
    expect(() => locale.register('common', 'zh', {})).toThrow('already has locale')
    expect(() => locale.register('common', 'en', {})).toThrow('already has locale')
    // No row of its own: the General item slot stays empty, and the row-owned
    // namespace is gone rather than merely unrendered.
    expect(b.slots.entries(SLOT)).toHaveLength(0)
    expect(locale.getLocale().locales.map(entry => entry.id)).toEqual(['zh', 'en'])
    locale.setLocale('zh')
    expect(() => locale.register('settings.locale', 'en', { 'language.title': 'x' })).not.toThrow()
  })

  it('loads and refreshes the explicit Host preference after nonblocking activation', async () => {
    const b = await bench()
    // The shared mirror read once at bench time; a Host-side change reaches it
    // through the document invalidation, exactly as production announces one.
    // Preference must differ from the provisional locale (FALLBACK_LOCALE = en
    // with no window), or clearing it below would be unobservable.
    b.setHostPreference('zh')
    b.ctx.remote.$dispatch('settings/document-updated', [LOCALE_SETTINGS_NAMESPACE, 0])
    declareItems(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const locale = b.ctx.get('locale') as LocaleRuntime
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('zh') })
    // Cleared preference falls back to the provisional locale.
    b.setHostPreference(undefined)
    b.ctx.remote.$dispatch('settings/document-updated', [LOCALE_SETTINGS_NAMESPACE, 0])
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('en') })
    // Re-selecting zh after the clear is an explicit pick of the provisional
    // value and must persist as a written preference.
    b.setHostPreference('zh')
    b.ctx.remote.$dispatch('settings/document-updated', [LOCALE_SETTINGS_NAMESPACE, 0])
    await vi.waitFor(() => { expect(locale.getLocale().active).toBe('zh') })
    expect(b.describe).toHaveBeenCalledTimes(4)
    expect(b.slots.entries(SLOT)).toHaveLength(0)
  })
})
