/**
 * LayoutController: the cross-plugin panel-action face behind ctx.layout.
 * Panel geometry itself lives in the root entry's layout store (stores.ts);
 * the current-session selection lives with the runtime sessions service, and
 * the per-session active view dissolved into ui-conversation's session store
 * (its only consumer). What remains here is the contract other plugins'
 * apply worlds reach for panel transitions (sidebar toggle from ui-sidebar,
 * details open/close from ui-conversation) — writes stay inside the store's
 * declared action set, delivered as the registration's bound actions.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { createLayoutStore } from './stores.ts'

/** The layout store's bound action set (framework-baked, draft params peeled). */
export type PanelActions = BoundActions<ReturnType<typeof createLayoutStore>>

/**
 * The outward layout face (`ctx.layout`): the panel transitions other
 * plugins may trigger — and exactly what a test fake must supply. The
 * attachPanels wiring hook stays on the concrete class (root-entry assembly
 * only).
 */
export interface ILayout {
  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void
  /** Open the details panel (no-op when already open). */
  openDetails(): void
  /** Close the details panel. */
  closeDetails(): void
  /** Open the right rail (no-op when already open). */
  openRail(): void
  /** Close the right rail. */
  closeRail(): void
  /** Toggle the right rail (open ⟷ contract default width). */
  toggleRail(): void
  /** Select a registered center page; null returns to the selected conversation.
   * @param id - registered page id, or null for the conversation.
   */
  openPage(id: string | null): void
}

/** Cross-plugin panel-action face (ctx.layout). */
export class LayoutController implements ILayout {
  #panels: PanelActions | undefined
  /** A page asked for before the root entry mounted (see openPage). */
  #pendingPage: string | null | undefined

  /**
   * Adopt the root entry's bound store actions. Called from the root
   * registration's inject hook (a sanctioned assembly side effect), so the
   * face is live from the entry's first render; on entry re-register the
   * fresh actions overwrite the stale set.
   *
   * A page requested before this point is applied here, inside that first
   * render: the frame reads its store snapshot after this hook runs, so the
   * page it paints is already the requested one and no frame paints the
   * conversation first.
   * @param actions - bound actions of the entry's layout store instance.
   */
  attachPanels(actions: PanelActions): void {
    this.#panels = actions
    const pending = this.#pendingPage
    if (pending === undefined) return
    this.#pendingPage = undefined
    actions.openPage(pending)
  }

  /** Toggle the sidebar panel (closed ⟷ contract default width). */
  toggleSidebar(): void {
    this.#require().toggleSidebar()
  }

  /** Open the details panel (no-op when already open). */
  openDetails(): void {
    this.#require().openDetails()
  }

  /** Close the details panel. */
  closeDetails(): void {
    this.#require().closeDetails()
  }

  /** Open the right rail (no-op when already open). */
  openRail(): void {
    this.#require().openRail()
  }

  /** Close the right rail. */
  closeRail(): void {
    this.#require().closeRail()
  }

  /** Toggle the right rail (open ⟷ contract default width). */
  toggleRail(): void {
    this.#require().toggleRail()
  }

  /** Select a center page without creating or changing an agent session.
   * @param id - registered page id, or null for the conversation.
   */
  openPage(id: string | null): void {
    // The one transition with a boot-time caller: the inbox restores the
    // channel it had open as soon as the server answers the channel list,
    // which can be before the root entry has rendered (the fetch is a real
    // network read; the frame's first render is a later task). The request is
    // the reader's intent, not a write that must land this instant, so it is
    // held and applied by attachPanels — being early is not a failure here.
    // Every other action below stays a gesture, which cannot precede the frame.
    if (this.#panels === undefined) { this.#pendingPage = id; return }
    this.#panels.openPage(id)
  }

  #require(): PanelActions {
    // Callers are UI gestures, which cannot fire before the root entry
    // rendered (the inject hook runs in its first render) — reaching this
    // unwired is a boot-order bug, not a race to tolerate.
    if (this.#panels === undefined) throw new Error('layout: panel actions not wired (root entry not mounted)')
    return this.#panels
  }
}
