/**
 * Pure concession-chain column solver for the four-column AppFrame
 * (sidebar | center | details | right rail).
 * Chain order is fixed by contract: keep center >= CENTER_MIN by shrinking the
 * right rail toward RAIL_MIN and then auto-closing it, and only then shrinking
 * and auto-closing details (every close is a derived zero width — preferred
 * widths are never rewritten, so widening the window restores them). The rail
 * concedes before details because details is a panel the reader opened on
 * purpose while the rail is persistent chrome: dropping a column someone asked
 * to see is the larger loss. That precedence is the one decision to revisit
 * when the rail holds content of its own. The sidebar never concedes: its
 * rendered width is always the drag preference (or the collapsed rail), and
 * center absorbs any remaining deficit as the last resort. Inputs are the
 * layout store's plain width preferences (0 = closed); a closed sidebar
 * resolves to the fixed SIDEBAR_COLLAPSED control rail while closed details and
 * a closed right rail resolve to zero width — the right rail has no compact
 * variant (`--ui-frame-rail-width` and SIDEBAR_COLLAPSED are the LEFT column's
 * rail, not a second state of this one). The SIDEBAR_AUTO_COLLAPSE breakpoint is
 * consumed by AppFrame, which decides the effective sidebar preference before
 * solving; the solver itself stays breakpoint-free.
 *
 * Portrait (frame width < frame height) is a SECOND contract, solved beside the
 * landscape chain and never mixed with it: the sidebar stops owning a grid
 * track and floats over the chat, so the center column keeps the full frame
 * width and the sidebar's widening becomes an overlay fact rather than a
 * concession one. The right rail has no portrait answer and resolves to zero
 * width there: portrait's contract is that the chat owns the frame and chrome
 * floats over it, so a second chrome column would either squeeze the chat (the
 * thing the contract forbids) or cover it. computeFrameLayout picks the
 * contract; computeColumns stays exactly the landscape answer.
 */

/**
 * Resolved widths for one frame (sidebar | center | details | rail); center may
 * drop below CENTER_MIN only at the final fallback.
 */
export interface Columns { sidebar: number; center: number; details: number; rail: number }

// Contract-frozen geometry: the concession chain's fixed points.
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
/** Right rail drag clamp floor; the sidebar's own floor, because the rail is
 * read as that column's twin. */
export const RAIL_MIN = SIDEBAR_MIN
/** Right rail drag clamp ceiling; the sidebar's own ceiling, for the same reason. */
export const RAIL_MAX = SIDEBAR_MAX
/** Right rail width before any user drag. The rail is chrome, not content, so it
 * opens at the sidebar's default width and closes to nothing — there is no
 * compact rail state on this side (see the module doc). */
export const RAIL_DEFAULT = SIDEBAR_DEFAULT

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
 * Solve the four column widths for one viewport frame. Pure: no hysteresis —
 * the output is a function of (viewport, preferences) only, so recovery on
 * re-widening is automatic. Preferences re-clamp here because they cross the
 * store boundary and callers may still supply stale ranges.
 * @param viewport - available frame width in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param rail - right rail width preference in px (0 = closed, and the default
 * callers get when they pass nothing); a caller with no writable conversation
 * passes 0 so the rail never becomes a track.
 * @returns resolved widths; details 0 and rail 0 mean visually closed (never
 * unmounted, so a panel keeps its DOM through a close), while a closed sidebar
 * keeps its compact rail.
 */
export function computeColumns(viewport: number, sidebar: number, details: number, rail = 0): Columns {
  // The sidebar is fixed at its preference (or the rail) — it never concedes.
  const s = sidebar === 0 ? SIDEBAR_COLLAPSED : clampWidth(sidebar, SIDEBAR_MIN, SIDEBAR_MAX)
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  const r0 = rail === 0 ? 0 : clampWidth(rail, RAIL_MIN, RAIL_MAX)

  // Step 1: everything fits at preferred widths.
  if (s + d0 + r0 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d0 - r0, details: d0, rail: r0 }

  // Step 2: shrink the rail toward its minimum (chrome concedes before the
  // panel the reader opened).
  const r1 = r0 === 0 ? 0 : Math.max(RAIL_MIN, viewport - s - d0 - CENTER_MIN)
  if (s + d0 + r1 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d0, rail: r1 }

  // Step 3: auto-close the rail (derived — preference untouched).
  if (s + d0 + CENTER_MIN <= viewport) return { sidebar: s, center: viewport - s - d0, details: d0, rail: 0 }

  // Step 4: shrink details toward its minimum.
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - s - CENTER_MIN)
  if (s + d1 + CENTER_MIN <= viewport) return { sidebar: s, center: CENTER_MIN, details: d1, rail: 0 }

  // Step 5: auto-close details (derived — preferences untouched); center
  // absorbs any remaining deficit (may drop below CENTER_MIN).
  return { sidebar: s, center: Math.max(0, viewport - s), details: 0, rail: 0 }
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
 * sidebar never covers it), through the same ladder as computeColumns. The right
 * rail answers zero width: portrait has no second chrome column (module doc).
 * @param viewport - available frame width in px.
 * @param details - details width preference in px (0 = closed).
 * @returns resolved tracks; sidebar is 0 because the floating column has no track,
 * and rail is 0 because a portrait frame paints no right rail at all.
 */
function computePortraitColumns(viewport: number, details: number): Columns {
  const d0 = details === 0 ? 0 : clampWidth(details, DETAILS_MIN, DETAILS_MAX)
  if (d0 + CENTER_MIN <= viewport) return { sidebar: 0, center: viewport - d0, details: d0, rail: 0 }
  const d1 = d0 === 0 ? 0 : Math.max(DETAILS_MIN, viewport - CENTER_MIN)
  if (d1 + CENTER_MIN <= viewport) return { sidebar: 0, center: CENTER_MIN, details: d1, rail: 0 }
  // Details auto-closes (derived — preferences untouched): with no sidebar
  // track in portrait, the chat then owns the whole frame.
  return { sidebar: 0, center: Math.max(0, viewport), details: 0, rail: 0 }
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
 * portrait frame is the overlay solve above with the sidebar taking no track and
 * no right rail painted.
 * @param width - frame width in px.
 * @param height - frame height in px.
 * @param sidebar - sidebar width preference in px (0 = closed).
 * @param details - details width preference in px (0 = closed).
 * @param rail - right rail width preference in px (0 = closed, and no rail at
 * all); a portrait frame ignores it by contract.
 * @returns the tracks and the portrait plan.
 */
export function computeFrameLayout(
  width: number,
  height: number,
  sidebar: number,
  details: number,
  rail = 0,
): FrameLayout {
  const portrait = planPortrait(width, height)
  const columns = portrait.portrait
    ? computePortraitColumns(width, details)
    : computeColumns(width, sidebar, details, rail)
  return { columns, portrait }
}
