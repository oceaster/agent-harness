/**
 * Browser half of the native directory-picker backend: fills ui-workspace's
 * sidebar directory-flow hole with a renderless occupant that answers each
 * `open` by driving `host.pickDirectory` (the node half's OS chooser) and
 * reporting the one outcome — picked path, cancellation, or failure — back
 * through the owner conversation. Mounting this package therefore composes
 * both sides of the native interaction with one cordis.yml row; no client
 * code branches on a capability kind.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { NativeFlowInjected } from './flow.ts'
import { NativeDirectoryFlow } from './flow.ts'


/** Required services (cordis fiber inject): the slot registry and the wire-facing workspace service. */
export const inject = ['slots', 'workspaces']

/**
 * Client plugin body: register the renderless native flow into the sidebar
 * directory-flow hole through `slots.inject()` because the ui-workspace entry
 * may activate later or replace its declaration. The conversation hero's hole
 * went with the hero workspace chip (FORK-NOTES "Inbox sidebar").
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const injected = (): NativeFlowInjected => ({ pick: () => ctx.workspaces.pickDirectory() })
  ctx.slots.inject('sidebar.workspaces.directoryFlow', () => ctx.slots.register({
    name: 'sidebar.workspaces.directoryFlow', inject: injected,
  }, NativeDirectoryFlow))
}
