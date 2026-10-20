/**
 * Settings shell and ownerless-copy plugin, browser half: renders the
 * `sidebar.settings` occupant — panel chrome, the one settings section, and the
 * onboarding stage — and registers everything on the Settings pages that
 * belongs to no single feature: the trigger/header/close chrome content, the
 * General section, and `settings` dictionaries. Feature-owned rows and sections
 * stay with their features.
 * Export discipline: packages/client/AGENTS.md.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the settings slot declarations. Cross-plugin collaboration goes
// through the service, never a value import (client bundle purity gate).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { SettingsOnboardingStep, SettingsRootInjected } from './shell-contract.ts'
import { SettingsRoot } from './SettingsRoot.tsx'
import { CloseLabel, HeaderContent, TriggerContent } from './chrome.tsx'
import { GeneralSection } from './GeneralSection.tsx'
import { createSettingsShellStore } from './settings-shell-store.ts'
import { en, zh, type SettingsKey } from './locales.ts'

export type {
  CloseLabelProps, HeaderContentProps, TriggerContentProps,
} from './chrome.tsx'
export type {
  GeneralSectionComponentProps,
} from './GeneralSection.tsx'
export type { SettingsShellActions, SettingsShellState } from './settings-shell-store.ts'
export { createSettingsShellStore } from './settings-shell-store.ts'
export type { SettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Shell chrome + shell-owned General section copy. */
    settings: SettingsKey
  }
}

/** Dictionary namespace owned by this plugin (shell chrome + General copy). */
const NS = 'settings'

/**
 * Required services (cordis fiber inject). The target slots are declared by
 * ui-settings' apply, whose activation order relative to this one is NOT
 * constrained; registrations depend on their slots through `slots.inject()`.
 */
export const inject = ['slots', 'locale']

/**
 * Register the `settings` dictionaries, the chrome content, and the General
 * section, each once its slot declaration is on the ledger.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-general: dictionaries')

  // The settings shell: this package occupies the sidebar-owned hole and
  // declares the settings slots. Ledger → ordered-id projection as an observable
  // source (uSES contract: getSnapshot returns the cached ids until the ledger
  // version moves). The panel renders the first id and offers no navigation, so
  // the projection carries no row label and subscribes to no locale revision.
  let idsVersion = -1
  let onboardingVersion = -1
  let sectionIds: readonly string[] = []
  let onboardingSteps: readonly SettingsOnboardingStep[] = []
  const shellInjected = (): SettingsRootInjected => ({
    hooks: {
      sectionIds: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.section')
          if (version !== idsVersion) {
            idsVersion = version
            sectionIds = ctx.slots.entries('settings.section')
              .map(e => ({ id: e.options.id ?? '', order: e.options.order ?? 0 }))
              .sort((a, b) => a.order - b.order)
              .map(row => row.id)
          }
          return sectionIds
        },
        subscribe: listener => ctx.slots.subscribe('settings.section', listener),
      },
      onboardingSteps: {
        getSnapshot: () => {
          const version = ctx.slots.getVersion('settings.onboarding')
          if (version !== onboardingVersion) {
            onboardingVersion = version
            onboardingSteps = ctx.slots.entries('settings.onboarding')
              .map(e => ({
                /* v8 ignore next -- list-slot registration requires id */
                id: e.options.id ?? '',
                order: e.options.order ?? 0,
              }))
              .sort((a, b) => a.order - b.order)
          }
          return onboardingSteps
        },
        subscribe: listener => ctx.slots.subscribe('settings.onboarding', listener),
      },
    },
  })
  ctx.slots.inject('sidebar.settings', () => ctx.slots.register({
    name: 'sidebar.settings',
    children: {
      'settings.trigger': { kind: 'single', scope: 'root' },
      'settings.header': { kind: 'single', scope: 'root' },
      'settings.close': { kind: 'single', scope: 'root' },
      'settings.section': { kind: 'list', scope: 'root' },
      'settings.onboarding': { kind: 'list', scope: 'root' },
    },
    // Exclusive store: the factory itself — the framework instantiates it for
    // this root-scope entry and delivers useStore/actions to SettingsRoot as
    // standard props. The shell's persisted state (open) rides there so a
    // reload restores the panel the reader left behind.
    store: createSettingsShellStore,
    inject: shellInjected,
  }, SettingsRoot))

  ctx.slots.inject('settings.trigger', () =>
    ctx.slots.register({ name: 'settings.trigger', locale: NS }, TriggerContent))
  ctx.slots.inject('settings.header', () =>
    ctx.slots.register({ name: 'settings.header', locale: NS }, HeaderContent))
  ctx.slots.inject('settings.close', () =>
    ctx.slots.register({ name: 'settings.close', locale: NS }, CloseLabel))
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'general',
    order: 0,
    locale: NS,
    children: { 'settings.general.item': { kind: 'list', scope: 'root' } },
  }, GeneralSection))
}
