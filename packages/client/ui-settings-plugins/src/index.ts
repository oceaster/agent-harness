/**
 * Plugins settings surface, node half. The empty apply exists so the plugin
 * appears in the host cordis.yml / Loader; the browser half owns the section
 * and its chrome through exports["./client"], discovered from the package.json
 * dsh.client declaration. The page is read-only, so this package registers no
 * settings namespace of its own and writes nothing.
 */

/** Host plugin body — no host-side behavior for this surface plugin. */
export function apply(): void {}
