/**
 * The root entry's layout store: panel geometry as plain widths in px (0 =
 * closed). Module level exports the factory only — a module-level
 * handle would pin the store's identity in the module
 * cache (a de-facto singleton surviving plugin reloads). register() receives
 * the factory (exclusive use: the framework instantiates per entry), AppFrame
 * derives its PropsStore share from the return type, and the service face
 * receives the bound actions through the registration's inject hook.
 *
 * The panel widths are durable across reloads (see createLayoutStore); the
 * viewport readings and the selected center page are not.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'
import {
  clampWidth, DETAILS_DEFAULT, DETAILS_MAX, DETAILS_MIN,
  RAIL_DEFAULT, RAIL_MAX, RAIL_MIN,
  SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
} from './columns.ts'

/**
 * Layout store state: panel width preferences in px (0 = closed), plus the
 * narrow-viewport pair — `narrow` mirrors AppFrame's breakpoint reading
 * (portrait, or viewport < SIDEBAR_AUTO_COLLAPSE) so toggleSidebar can pick
 * semantics, and `narrowExpanded` is the manual override that re-expands the
 * auto-collapsed sidebar over the squeezed center without rewriting the width
 * preference. `portrait` mirrors AppFrame's shape reading (width < height) and
 * gates the collapse-on-selection rule: only a portrait frame collapses the
 * column when a conversation or channel is chosen.
 */
type LayoutState = {
  sidebar: number
  details: number
  rail: number
  narrow: boolean
  narrowExpanded: boolean
  portrait: boolean
  page: string | null
}

/**
 * Annotation twin of the actions literal below (the export needs a declared
 * return type); drift fails assignability at the defineStore call.
 */
type LayoutActions = {
  setSidebar: (draft: LayoutState, px: number) => void
  setDetails: (draft: LayoutState, px: number) => void
  setRail: (draft: LayoutState, px: number) => void
  openRail: (draft: LayoutState) => void
  closeRail: (draft: LayoutState) => void
  toggleRail: (draft: LayoutState) => void
  toggleSidebar: (draft: LayoutState) => void
  setNarrow: (draft: LayoutState, narrow: boolean) => void
  setPortrait: (draft: LayoutState, portrait: boolean) => void
  collapseOnSelection: (draft: LayoutState) => void
  openDetails: (draft: LayoutState) => void
  closeDetails: (draft: LayoutState) => void
  openPage: (draft: LayoutState, id: string | null) => void
}

/**
 * Create the layout panel store handle. The preference IS the width, so
 * closing a panel forgets its drag width — reopening restores the contract
 * default. Actions are the complete write set: drag writes clamp
 * into the panel's contract range and never cross the open/closed line;
 * open/close transitions write 0 / the default explicitly. Below the
 * auto-collapse breakpoint (AppFrame feeds setNarrow) the sidebar toggle
 * flips the narrowExpanded override instead of the preference.
 *
 * Persistence is a SUBSET on purpose: only the two panel widths are durable.
 * `narrow`, `narrowExpanded` and `portrait` are measurements of the current
 * frame — AppFrame re-reads them on every measure and both setters drop the
 * manual override when the measurement changes, so storing them would replay
 * a stale viewport's answer and fight the frame that owns it. `page` is not
 * durable here either: the channel page has one writer (ui-inbox, which
 * restores the open channel id and selects the page in the same step), and a
 * second writer would paint the conversation for a frame before it lands.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createLayoutStore(): EngineStoreHandle<LayoutState, LayoutActions>  {
  const handle = defineStore({
    init: (): LayoutState => ({
      sidebar: SIDEBAR_DEFAULT, details: 0, rail: RAIL_DEFAULT,
      narrow: false, narrowExpanded: false, portrait: false, page: null,
    }),
    persist: {
      name: 'dsh.layout.panels',
      partial: (state: LayoutState) => ({ sidebar: state.sidebar, details: state.details, rail: state.rail }),
    },
    actions: {
      setSidebar: (d, px: number) => { d.sidebar = clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX) },
      setDetails: (d, px: number) => { d.details = clampWidth(px, DETAILS_MIN, DETAILS_MAX) },
      setRail: (d, px: number) => { d.rail = clampWidth(px, RAIL_MIN, RAIL_MAX) },
      // Narrow toggles flip only the override: the width preference survives
      // untouched, so re-widening restores the pre-squeeze layout.
      toggleSidebar: (d) => {
        if (d.narrow) d.narrowExpanded = !d.narrowExpanded
        else d.sidebar = d.sidebar === 0 ? SIDEBAR_DEFAULT : 0
      },
      // Crossing the breakpoint in either direction drops the override: the
      // narrow default is auto-collapsed, the wide state is the preference.
      setNarrow: (d, narrow: boolean) => {
        if (d.narrow === narrow) return
        d.narrow = narrow
        d.narrowExpanded = false
      },
      // Shape changes drop the override for the same reason: a rotated or
      // resized frame starts from its own contract default, not a stale one.
      setPortrait: (d, portrait: boolean) => {
        if (d.portrait === portrait) return
        d.portrait = portrait
        d.narrowExpanded = false
      },
      // Collapse-on-selection: a chosen conversation or channel hands the screen
      // back to the chat. Portrait only, by contract — a landscape frame keeps
      // its column on a selection exactly as it always did, manually expanded
      // narrow landscape included. Writes the override, never the preference, and
      // fires from the selection event: a manual expand survives until the next
      // selection.
      collapseOnSelection: (d) => {
        if (!d.portrait) return
        d.narrowExpanded = false
      },
      openDetails: (d) => { if (d.details === 0) d.details = DETAILS_DEFAULT },
      // Rail transitions mirror the details pair. They exist as API, not as new
      // chrome: this sprint the column is empty, so the frame paints no toggle
      // for it — a caller that wants a control owns that control (ui-sidebar's
      // fold toggle is the shape to copy).
      openRail: (d) => { if (d.rail === 0) d.rail = RAIL_DEFAULT },
      closeRail: (d) => { d.rail = 0 },
      toggleRail: (d) => { d.rail = d.rail === 0 ? RAIL_DEFAULT : 0 },
      closeDetails: (d) => { d.details = 0 },
      openPage: (d, id: string | null) => { d.page = id; d.details = 0 },
    },
  })
  return handle
}
