/**
 * Learn More slot contract: the injected business face the section renders and
 * the composed props alias. The `settings.section` entry itself is declared by
 * the settings shell (imported type-only for its SlotMap merge).
 *
 * The inject face carries plain data and one callback: the snapshot source
 * rides the reserved `hooks` compartment (the renderer binds it to `useLearn`),
 * and `load` is a closure over the apply-scope controller.
 */
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls ui-settings' SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { LearnState } from './learn-controller.ts'

/** Registrant-private injected share (arrives via the register inject factory). */
export interface LearnInjected {
  hooks: {
    /** The controller's whole snapshot: the guides, the person, and the failure. */
    learn: SnapshotStore<LearnState>
  }
  /** Read (or re-read) the caller's guides through the learn API. */
  load: () => void
}

/** Full component props: the slot's runtime share, the injected face, and the locale seat. */
export type LearnSectionProps =
  PropsRuntime<'settings.section'>
  & InjectFace<LearnInjected>
  & PropsLocale<'settings.learn'>

export type { LearnState } from './learn-controller.ts'
