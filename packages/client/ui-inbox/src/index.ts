/**
 * Inbox plugin, node half. Pure UI plugin: the empty apply exists so the
 * plugin appears in the host cordis.yml / Loader; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client
 * declaration.
 *
 * SPIKE PROTOTYPE (branch spike/inbox-ui, throwaway): proving that a new
 * client plugin package can be composed into the web bundle and reach the
 * browser as a loaded client plugin.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
