/**
 * Settings shell contract — the types of the `sidebar.settings` occupant this
 * package renders. They live here rather than in ui-settings because they
 * reference the sidebar's own slot type: ui-settings is the settings domain's
 * base layer and must not depend on any `ui-*` presentation package, or the
 * reference graph closes a cycle through ui-sidebar → ui-layout → ui-theme.
 * The settings SLOT types (what registrants contribute) stay in ui-settings.
 */
import type { HostObservable, InjectFace, PropsRenderSlots, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.settings' entry)
// into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the settings slot declarations the shell renders into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: the shell's own store (declared with the registration in index.ts).
import type { EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import type { SettingsShellActions, SettingsShellState } from './settings-shell-store.ts'

/** One nav row projected from a settings.section registration's options. */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** One ordered onboarding step projected from a slot registration. */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * Registrant-private injected share of the settings shell (assembled in
 * apply): the ledger's nav-row projection as a hooks-compartment source —
 * the shell reads no locale state and subscribes through the bound hook.
 */
export type SettingsRootInjected = {
  hooks: {
    /** settings.section ledger projected into ordered nav rows. */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
}

/**
 * The shell's own store handle: `createSettingsShellStore`'s return type, so the
 * props share below and the registration in index.ts cannot drift apart.
 */
export type SettingsShellStoreHandle =
  EngineStoreHandle<SettingsShellState, SettingsShellActions>

/**
 * Full component props of the settings shell root: the sidebar owner share
 * (wide/rail state), the declared render shares, the injected face (hooks
 * compartment bound to useSections), and the registration's store seat —
 * modal open state and the active section id live in that store so a reload
 * restores the reader's position instead of dropping it.
 */
export type SettingsRootComponentProps =
  PropsRuntime<'sidebar.settings'>
  & PropsRenderSlots<
    | 'settings.trigger'
    | 'settings.header'
    | 'settings.action'
    | 'settings.close'
    | 'settings.section'
    | 'settings.onboarding'
  >
  & InjectFace<SettingsRootInjected>
  & PropsStore<SettingsShellStoreHandle>
