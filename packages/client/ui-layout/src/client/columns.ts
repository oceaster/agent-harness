/**
 * Pure concession-chain column solver for the three-column AppFrame.
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking
 * details, then auto-closing it (derived zero width — preferred width
 * preferences are never rewritten, so widening the window restores them).
 * The sidebar never concedes: its rendered width is always the drag
 * preference (or the collapsed rail), and center absorbs any remaining
 * deficit as the last resort. Inputs are the layout store's plain width
 * preferences (0 = closed); a closed sidebar resolves to the fixed
 * SIDEBAR_COLLAPSED control rail while closed details resolve to zero width.
 * The SIDEBAR_AUTO_COLLAPSE breakpoint is consumed by AppFrame, which decides
 * the effective sidebar preference before solving; the solver itself stays
 * breakpoint-free.
 *
 * Portrait (frame width < frame height) is a SECOND contract, solved beside the
 * landscape chain and never mixed with it: the sidebar stops owning a grid
 * track and floats over the chat, so the center column keeps the full frame
 * width and the sidebar's widening becomes an overlay fact rather than a
 * concession one. computeFrameLayout picks the contract; computeColumns stays
 * exactly the landscape answer.
 */

/** Resolved widths for one frame; center may drop below CENTER_MIN only at the final fallback. */
export interface Columns { sidebar: number; center: number; details: number }

// Contract-frozen geometry: the three-column concession chain's fixed points.
/** Center column floor; only the final fallback may go below it. */
export const CENTER_MIN = 640
/** Sidebar drag clamp floor. */
export const SIDEBAR_MIN = 264
/** Sidebar drag clamp ceiling. */
export const SIDEBAR_MAX = 420
/** Sidebar width before any user drag. */
export const SIDEBAR_DEFAULT = 280
/** Closed-sidebar rail: a 24px icon column between 16px horizontal paddings. */
export const SIDEBAR_COLLAPSED = 56
/** Viewport width below which the sidebar auto-collapses to the rail (deepsuite
 * LG breakpoint); a manual toggle below it re-expands over the squeezed center
 * (stores.ts narrowExpanded). Bind applies to landscape only: portrait has its
 * own overlay geometry (computeFrameLayout). */
export const SIDEBAR_AUTO_COLLAPSE = 1024
/** Portrait widened sidebar: the frame fraction the floating column takes. */
export const SIDEBAR_PORTRAIT_RATIO = 0.62
/** Portrait widened sidebar ceiling; 210px above the landscape SIDEBAR_MAX clamp. */
export const SIDEBAR_PORTRAIT_MAX = 620
/** Portrait frame width at or below which the expanded sidebar is a full-frame
 * menu (mobile portrait) instead of a widened floating column. */
export const PORTRAIT_MOBILE_MAX = 600
/** Details drag clamp floor. */
export const DETAILS_MIN = 300
/** Details drag clamp ceiling. */
export const DETAILS_MAX = 520
/** Details width before any user drag. */
export const DETAILS_DEFAULT = 360

/**
 * Clamp a panel width into its contract range.
 * @param px - requested width.
 * @param min - range lower bound.
 * @param max - range upper bound.
 * @returns the clamped width.
 */
export function clampWidth(px: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(px)))
}

/**
 * Solve the three column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns resolved widths; details 0 means visually closed (never unmounted), while a closed sidebar keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + d0 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d0, details: d0 }

  // Step 2: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN)
  if (s + d1 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1 }

  // Step 3: auto-close details (derived — preferences untouched); center
  // absorbs any remaining deficit (may drop below CENTER_MIN).
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0 }
}

/**
 * Whether a frame is portrait-shaped: taller than it is wide. The comparison is
 * strict, so a square frame (width === height) takes the landscape path — the
 * concession chain — and every landscape frame behaves exactly as it did before
 * portrait existed.
 * @param width - frame width in px.
 * @param height - frame height in px.
 * @returns true for a frame taller than it is wide.
 */
export function isPortrait(width: number, height: number): boolean {
  return width < height
}

/**
 * The width of the expanded floating sidebar in portrait: a fixed fraction of
 * the frame, capped at the portrait ceiling, so a widened column covers most of
 * a tablet frame instead of the 420px landscape clamp. There is no floor: the
 * smallest frame that reaches this path is one pixel above PORTRAIT_MOBILE_MAX,
 * where the fraction already clears the landscape maximum.
 * @param viewport - frame width in px.
 * @returns the capped floating width.
 */
export function portraitSidebarWidth(viewport: number): number {
  return Math.min(SIDEBAR_PORTRAIT_MAX, Math.round(viewport * SIDEBAR_PORTRAIT_RATIO))
}

/**
 * Portrait plan for one frame: how wide the floating sidebar is when expanded,
 * and whether it takes the whole frame (mobile portrait: a full-frame menu that
 * slides in from the left). Inert in landscape — `portrait: false`, width 0 — so
 * no landscape caller can read a portrait number.
 */
export interface PortraitPlan {
  /** True when the frame is portrait-shaped; the sidebar floats over the chat. */
  portrait: boolean
  /** Floating sidebar width when expanded, in px (0 in landscape). */
  width: number
  /** The floating sidebar spans the whole frame width (mobile portrait). */
  fullscreen: boolean
}

/**
 * Read the portrait plan off the frame box.
 * @param width - frame width in px.
 * @param height - frame height in px.
 * @returns the plan; the landscape answer is inert.
 */
export function planPortrait(width: number, height: number): PortraitPlan {
  if (!isPortrait(width, height)) return { portrait: false, width: 0, fullscreen: false }
  const fullscreen = width <= PORTRAIT_MOBILE_MAX
  return { portrait: true, width: fullscreen ? width : portraitSidebarWidth(width), fullscreen }
}

/**
 * Solve the landscape keys for a portrait frame: the sidebar owns no track, so
 * the center column keeps the frame width it has with the sidebar collapsed. Only
 * details still concedes here (it is a right-hand column, and the floating
 * sidebar never covers it), through the same three steps as computeColumns.
 * @param viewport - available frame width in px.
 * @param details - details width preference in px (0 = closed).
 * @returns resolved tracks; sidebar is 0 because the floating column has no track.
 */
function computePortraitColumns(viewport: number, details: number): Columns {
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  if (d0 + CENTER_MIN <= viewport) return { sidebar: 0, center: viewport - d0, details: d0 }
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - CENTER_MIN)
  if (d1 + CENTER_MIN <= viewport) return { sidebar: 0, center: CENTER_MIN, details: d1 }
  // Details auto-closes (derived — preferences untouched): with no sidebar
  // track in portrait, the chat then owns the whole frame.
  return { sidebar: 0, center: Math.max(0, viewport), details: 0 }
}

/** One frame's resolved geometry: the grid tracks, plus the portrait overlay plan. */
export interface FrameLayout {
  /** Grid tracks to render (sidebar track is 0 while portrait overlays the chat). */
  columns: Columns
  /** Portrait overlay plan; inert in landscape. */
  portrait: PortraitPlan
}

/**
 * Solve one frame against the geometry contract that matches its shape. The two
 * contracts are disjoint: a landscape frame is computeColumns unchanged, a
 * portrait frame is the overlay solve above with the sidebar taking no track.
 * @param width - frame width in px.
 * @param height - frame height in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @returns the tracks and the portrait plan.
 */
export function computeFrameLayout(
  width: number,
  height: number,
  sidebar: number,
  details: number,
): FrameLayout {
  const portrait = planPortrait(width, height)
  const columns = portrait.portrait
    ? computePortraitColumns(width, details)
    : computeColumns(width, sidebar, details)
  return { columns, portrait }
}
