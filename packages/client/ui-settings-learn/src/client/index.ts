/**
 * Learn More plugin, browser half: one `settings.section` that explains, per
 * agent the signed-in person may use, how that agent works and how to get the
 * best out of it.
 *
 * The words are not this plugin's: e-server serves them at
 * `GET /v1/browser/learn` for the caller's own roster, because the guides are
 * household content that must be editable without rebuilding a browser bundle.
 * The plugin therefore carries no agent id, no agent name, no section id and no
 * sentence of guide prose — it renders whatever arrives, in the order it
 * arrives, so a section added on the server appears here and a section removed
 * there disappears.
 *
 * Placement: between General (`order: 0`) and Plugins (`order: 15`). Learning
 * what an agent is for belongs after the settings a person changes on purpose
 * and before the deployment's plumbing.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the settings shell's SlotMap merge (the 'settings.section' entry).
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { createLearnApi } from './learn-api.ts'
import { LearnController } from './learn-controller.ts'
import { LearnSection } from './LearnSection.tsx'
import { en, zh, type LearnKey } from './locales.ts'
import type { LearnInjected } from './slots.ts'

export type { LearnAgent, LearnFailure, LearnFailureCode, LearnGuides, LearnOutcome, LearnPerson, LearnSection } from './learn-api.ts'
export type { LearnState, LearnStatus } from './learn-controller.ts'
export type { LearnInjected, LearnSectionProps } from './slots.ts'
export type { LearnKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Learn More section's copy. */
    'settings.learn': LearnKey
  }
}

/** Dictionary namespace owned by this plugin. */
const NS = 'settings.learn'

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale']

/**
 * Register the Learn More section once the settings shell declares the hole.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-settings-learn: dictionaries')

  const controller = new LearnController({ api: createLearnApi() })
  const injected = (): LearnInjected => ({
    hooks: { learn: controller.store },
    load: () => { void controller.load() },
  })

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'learn',
    order: 5,
    label: () => ctx.locale.bind(NS)('nav'),
    locale: NS,
    inject: injected,
  }, LearnSection))
}
