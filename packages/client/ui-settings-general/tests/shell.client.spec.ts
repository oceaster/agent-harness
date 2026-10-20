/** Settings shell registration: slot declaration injection, the ledger projections, and HMR recovery. */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import type { SettingsRootInjected } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  // Copy machinery for the shell's dictionaries; the real locale plugin would
  // drag its own settings-row dependencies into this bench.
  ctx.provide('locale', {
    register: () => () => {},
    bind: () => (key: string) => key,
    getSnapshot: () => ({ active: 'zh', locales: [], revision: 0 }),
    subscribe: () => () => {},
  } as never)
  // Services ui-settings' own apply injects (its settings mirror); this bench
  // declares the slots and never exercises the wire.
  ctx.provide('connection', {
    api: { settings: { describe: async () => ({ result: { ok: false } }) } },
    isLoopback: false,
  } as never)
  ctx.provide('remote', { $on: () => () => {} } as never)
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register(
    { name: 'root', children: { 'sidebar.settings': { kind: 'single', scope: 'root' } } } as never,
    () => null,
  )
}

function injectedOf(slots: SlotRegistry): SettingsRootInjected {
  const entry = slots.entries('sidebar.settings')[0]!
  return (entry.inject as () => SettingsRootInjected)()
}

/** The shell's child declarations (chrome, sections, and onboarding overlays). */
const CHILD_SPECS = {
  'settings.trigger': { kind: 'single', scope: 'root' },
  'settings.header': { kind: 'single', scope: 'root' },
  'settings.close': { kind: 'single', scope: 'root' },
  'settings.section': { kind: 'list', scope: 'root' },
  'settings.onboarding': { kind: 'list', scope: 'root' },
} as const

describe('ui-settings apply', () => {
  it('declares only the services a pure composition face uses', () => {
    // `connection` and `settingsScope` left with the configuration-file action:
    // this package reads no settings wire and owns no document store.
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers the shell and declares every child slot, before or after the declaration', async () => {
    const before = await bench()
    declare(before.slots)
    await before.ctx.plugin({ inject: [...inject], apply }).await()
    expect(before.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    for (const name of Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>) {
      expect(before.slots.spec(name)).toEqual(CHILD_SPECS[name])
    }

    const after = await bench()
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    expect(after.slots.entries('sidebar.settings')).toHaveLength(0)
    declare(after.slots)
    await Promise.resolve()
    expect(after.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    // The self-inflicted ledger notifications hit the duplicate guard.
    expect(after.slots.entries('sidebar.settings')).toHaveLength(1)
  })

  it('projects the section ledger into ordered ids with option defaults', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { sectionIds } = injectedOf(b.slots).hooks
    // This package registers the General section itself; every other section
    // arrives from a feature registrant. Labels play no part — the panel renders
    // one section and there is no nav to caption.
    expect(sectionIds.getSnapshot()).toEqual(['general'])
    b.slots.register({ name: 'settings.section', id: 'z', order: 20 } as never, () => null)
    // No order: the projection default applies, so `a` sorts before `z`.
    b.slots.register({ name: 'settings.section', id: 'a' } as never, () => null)
    expect(sectionIds.getSnapshot()).toEqual(['general', 'a', 'z'])
    // Snapshot identity is stable until the ledger moves (uSES contract).
    expect(sectionIds.getSnapshot()).toBe(sectionIds.getSnapshot())
    const rows = sectionIds.getSnapshot()
    const listener = vi.fn()
    const off = sectionIds.subscribe(listener)
    b.slots.register({ name: 'settings.section', id: 'b', order: 1 } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalled()
    expect(sectionIds.getSnapshot()).not.toBe(rows)
    off()
  })

  it('projects onboarding entries into stable coordinator order', async () => {
    const b = await bench()
    declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    const { onboardingSteps } = injectedOf(b.slots).hooks
    b.slots.register({ name: 'settings.onboarding', id: 'credential', order: 0 } as never, () => null)
    b.slots.register({ name: 'settings.onboarding', id: 'welcome', order: -100 } as never, () => null)
    b.slots.register({ name: 'settings.onboarding', id: 'default-order' } as never, () => null)
    const steps = onboardingSteps.getSnapshot()
    expect(steps).toEqual([
      { id: 'welcome', order: -100 },
      { id: 'credential', order: 0 },
      { id: 'default-order', order: 0 },
    ])
    expect(onboardingSteps.getSnapshot()).toBe(steps)
    const listener = vi.fn()
    const off = onboardingSteps.subscribe(listener)
    b.slots.register({ name: 'settings.onboarding', id: 'later', order: 10 } as never, () => null)
    await Promise.resolve()
    expect(listener).toHaveBeenCalledOnce()
    off()
  })

  it('re-registers after an HMR collapse re-declares the slot (stale disposer must not block)', async () => {
    const b = await bench()
    const redeclare = declare(b.slots)
    await b.ctx.plugin({ inject: [...inject], apply }).await()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(1)
    // Declarer unload: the cascade removes our entry and every child
    // declaration while our local disposer variable goes stale.
    redeclare()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(0)
    expect(b.slots.spec('settings.trigger')).toBeUndefined()
    declare(b.slots)
    await Promise.resolve()
    expect(b.slots.entries('sidebar.settings')[0]!.component).toBe(SettingsRoot)
    for (const name of Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>) {
      expect(b.slots.spec(name)).toEqual(CHILD_SPECS[name])
    }
  })

  it('unregisters the shell and collapses every child slot on teardown', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(b.slots.entries('sidebar.settings')).toHaveLength(0)
    for (const name of Object.keys(CHILD_SPECS) as Array<keyof typeof CHILD_SPECS>) {
      expect(b.slots.spec(name)).toBeUndefined()
    }
  })
})
