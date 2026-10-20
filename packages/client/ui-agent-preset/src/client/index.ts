/**
 * Agent-preset surface plugin, browser half — one surface: the session
 * header's read-only label naming the preset a session runs.
 *
 * A running session keeps the composition it began with (the host refuses to
 * adopt an existing session under a different preset), so the only honest
 * affordance is naming what is running. Which agent a conversation uses is
 * decided by the inbox row that starts it, and the deployment's default
 * preset belongs to the composition, so nothing here chooses or writes a
 * preset — the roster is read for display copy alone.
 */

import type { ConnectionHandle } from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the ctx.remote merge and the forwarded-event key face
// (the preset-commit echo rides the allowlist) into this program.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { AgentPresetLabel } from './AgentPresetLabel.tsx'
import type { AgentPresetLabelInjected } from './AgentPresetLabel.tsx'
import { en, zh } from './locales.ts'
import { AgentPresetRosterController } from './roster-store.ts'

import type { AgentPresetSettingsKey } from './locales.ts'

export type { AgentPresetLabelInjected, AgentPresetLabelProps } from './AgentPresetLabel.tsx'
export type { AgentPresetOption, AgentPresetRosterState } from './roster-store.ts'
export type { AgentPresetSettingsKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The header label's copy and the shipped presets' display names. */
    'settings.agentPreset': AgentPresetSettingsKey
  }
}

/** Required services (cordis fiber inject). */
export const inject = ['slots', 'locale', 'connection', 'remote', 'sessions']

/**
 * Mount the session-header label and keep the session row's preset current.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const { api } = ctx.get('connection') as ConnectionHandle
  const roster = new AgentPresetRosterController(api)

  ctx.effect(() => ctx.locale.register('settings.agentPreset', { zh, en }), 'ui-agent-preset: label dictionaries')

  // Every tab folds a committed switch into the shared session row; the
  // initiating tab may already have applied the RPC echo, which is idempotent.
  // The row is what this label renders, so a switch made in another tab must
  // reach it.
  ctx.effect(() => ctx.remote.$on('agent-preset/selected', (sessionId, agentPreset) => {
    ctx.sessions.noteAgentPreset(sessionId, agentPreset)
  }), 'ui-agent-preset: preset commits land in the session row')

  const injected = (): AgentPresetLabelInjected => ({
    hooks: { agentPresets: roster.store },
    load: () => roster.load(),
  })

  ctx.slots.inject('conversation.session.header.mode', () => ctx.slots.register({
    name: 'conversation.session.header.mode',
    locale: 'settings.agentPreset',
    inject: injected,
  }, AgentPresetLabel))
}
