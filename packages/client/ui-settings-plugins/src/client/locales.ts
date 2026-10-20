/** Locale bundle for the Plugins settings section chrome. */

/** Locale keys this surface renders. */
export type PluginsSettingsLocaleKey =
  | 'nav' | 'title' | 'intro' | 'tabs' | 'empty'

/**
 * English copy. The intro states what the page shows and never implies a
 * control: plugin configuration is decided on the server, so promising an edit
 * here would be a promise this deployment cannot keep.
 */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Plugins',
  title: 'Plugins',
  intro: 'The plugins this deployment runs, in the state it runs them.',
  tabs: 'Plugin views',
  empty: 'This deployment offers no plugin views.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '插件',
  title: '插件',
  intro: '本部署运行的插件，以及它们当前的运行状态。',
  tabs: '插件视图',
  empty: '本部署没有提供插件视图。',
}
