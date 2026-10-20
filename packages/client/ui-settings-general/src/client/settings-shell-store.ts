/**
 * Settings shell viewing state: whether the modal is open. This is the reader's
 * position in the settings surface, so it is a store rather than component
 * state — and it persists, because a reload that silently dropped the panel (or
 * reopened it) is a reload that loses the reader's place.
 *
 * The state is one remembered boolean, not the absence of one: a closed modal is
 * written as `false`, so a reload lands on a closed modal instead of
 * surprise-reopening one.
 *
 * There is deliberately no section id beside it. The panel renders the single
 * registered section and has no navigation, so a stored id would be a key that
 * can never resolve. `partial` is what retires the one an earlier build wrote:
 * rehydration merges only `open` over the initial state, and every write stores
 * only `open`, so an `{open, sectionId}` entry left in `dsh.settings.shell` is
 * rewritten without its section half on the reader's next open or close.
 *
 * Root scope (the `sidebar.settings` slot is a root-scope single), so the
 * engine's persist key stays unsuffixed: `dsh.settings.shell`.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Persisted settings-shell state. */
export interface SettingsShellState {
  /** Modal visibility; `false` is the remembered closed state. */
  open: boolean
}

/** Annotation twin of the actions literal below (the export needs a declared return type). */
export type SettingsShellActions = {
  open: (draft: SettingsShellState) => void
  close: (draft: SettingsShellState) => void
}

/**
 * Create the settings-shell store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createSettingsShellStore(): EngineStoreHandle<SettingsShellState, SettingsShellActions> {
  return defineStore({
    init: (): SettingsShellState => ({ open: false }),
    // The durable subset is exactly `open`, so a legacy entry that also carries a
    // section id rehydrates as `{ open }` and is rewritten without it.
    persist: { name: 'dsh.settings.shell', partial: state => ({ open: state.open }) },
    actions: {
      open: (d) => { d.open = true },
      // Closing records the closed state rather than clearing it.
      close: (d) => { d.open = false },
    },
  })
}
