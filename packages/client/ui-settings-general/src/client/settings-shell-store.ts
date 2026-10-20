/**
 * Settings shell viewing state: whether the modal is open and which section it
 * last showed. This is the reader's position in the settings surface, so it is
 * a store rather than component state — and it persists, because a reload that
 * silently dropped the panel (or reopened it) is a reload that loses the
 * reader's place.
 *
 * Two deliberate choices live in the state shape:
 *
 * - `open` is a remembered value, not the absence of one. A closed modal is
 *   written as `false`, so a reload lands on a closed modal instead of
 *   surprise-reopening one.
 * - `sectionId` survives `close()`. The last section the reader looked at is
 *   what a reopen returns to; clearing it would "helpfully" reset the panel to
 *   the first row, which is a different reading position. The panel's
 *   render-time projection only falls back to the first row when the stored id
 *   is no longer registered at all.
 *
 * Root scope (the `sidebar.settings` slot is a root-scope single), so the
 * engine's persist key stays unsuffixed: `dsh.settings.shell`.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Persisted settings-shell state. */
export interface SettingsShellState {
  /** Modal visibility; `false` is the remembered closed state. */
  open: boolean
  /** Last shown section id, kept while the modal is closed; null before any choice. */
  sectionId: string | null
}

/** Annotation twin of the actions literal below (the export needs a declared return type). */
export type SettingsShellActions = {
  open: (draft: SettingsShellState) => void
  close: (draft: SettingsShellState) => void
  select: (draft: SettingsShellState, id: string) => void
  openSection: (draft: SettingsShellState, id: string) => void
}

/**
 * Create the settings-shell store handle.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createSettingsShellStore(): EngineStoreHandle<SettingsShellState, SettingsShellActions> {
  return defineStore({
    init: (): SettingsShellState => ({ open: false, sectionId: null }),
    persist: 'dsh.settings.shell',
    actions: {
      open: (d) => { d.open = true },
      // Closing records the closed state and keeps the reading position.
      close: (d) => { d.open = false },
      select: (d, id: string) => { d.sectionId = id },
      // Onboarding reaches one section by id: show it, and open the panel on it
      // in the same write so a watching reader never sees the old section flash.
      openSection: (d, id: string) => {
        d.sectionId = id
        d.open = true
      },
    },
  })
}
