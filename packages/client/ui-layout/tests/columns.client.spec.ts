import { describe, expect, it } from 'vitest'
import {
  CENTER_MIN, clampWidth, computeColumns, computeFrameLayout, isPortrait, planPortrait,
  DETAILS_DEFAULT, DETAILS_MIN, PORTRAIT_MOBILE_MAX,
  RAIL_DEFAULT, RAIL_MAX, RAIL_MIN,
  SIDEBAR_COLLAPSED, SIDEBAR_DEFAULT, SIDEBAR_MAX, SIDEBAR_MIN,
  SIDEBAR_PORTRAIT_MAX, SIDEBAR_PORTRAIT_RATIO,
} from '@deepseek-ai/dsh-client-ui-layout/src/client/columns.ts'

// Numeric preference form (0 = closed); helpers keep the scenario names readable.
const open = (width: number) => width
const closed = (_width: number) => 0

describe('clampWidth', () => {
  it('clamps into the range and rounds', () => {
    expect(clampWidth(250.4, 240, 420)).toBe(250)
    expect(clampWidth(100, 240, 420)).toBe(240)
    expect(clampWidth(9999, 240, 420)).toBe(420)
  })
})

describe('computeColumns', () => {
  it('step 1: everything fits at preferred widths', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 1920 - 280 - 360, details: 360, rail: 0 })
  })

  it('closed sidebar keeps its compact rail while closed details contribute zero width', () => {
    expect(computeColumns(1920, closed(300), closed(360)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 1920 - SIDEBAR_COLLAPSED, details: 0, rail: 0 })
  })

  it('preferences beyond the clamp range are clamped before solving', () => {
    const cols = computeColumns(1920, open(9999), open(1))
    expect(cols.sidebar).toBe(420)
    expect(cols.details).toBe(300)
    expect(computeColumns(1920, open(1), open(DETAILS_DEFAULT)).sidebar).toBe(SIDEBAR_MIN)
  })

  it('step 2: details shrinks first, center pinned at min', () => {
    // 280 + 360 + 640 = 1280 > 1250; details concedes to 1250-280-640 = 330.
    const cols = computeColumns(1250, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: CENTER_MIN, details: 330, rail: 0 })
  })

  it('boundary: exactly at the step-1/step-2 seam', () => {
    const cols = computeColumns(300 + 360 + CENTER_MIN, open(300), open(360))
    expect(cols).toEqual({ sidebar: 300, center: CENTER_MIN, details: 360, rail: 0 })
    const one = computeColumns(300 + 360 + CENTER_MIN - 1, open(300), open(360))
    expect(one).toEqual({ sidebar: 300, center: CENTER_MIN, details: 359, rail: 0 })
  })

  it('step 3: details auto-closes when its min still starves center — sidebar holds its preference', () => {
    // 280 + 300 + 640 = 1220 > 1210 → details 0; sidebar untouched: center = 1210-280 = 930.
    const cols = computeColumns(1210, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: 280, center: 930, details: 0, rail: 0 })
  })

  it('the sidebar never concedes: center absorbs the deficit below CENTER_MIN', () => {
    // 700 < 280+640: sidebar keeps 280, center takes 420 < CENTER_MIN.
    const cols = computeColumns(700, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 420, details: 0, rail: 0 })
  })

  it('sidebar-closed narrow window: details concedes then auto-closes', () => {
    const fits = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN, closed(300), open(DETAILS_DEFAULT))
    expect(fits).toEqual({ sidebar: SIDEBAR_COLLAPSED, center: CENTER_MIN, details: DETAILS_MIN, rail: 0 })
    const starved = computeColumns(SIDEBAR_COLLAPSED + DETAILS_MIN + CENTER_MIN - 1, closed(300), open(DETAILS_DEFAULT))
    expect(starved).toEqual({
      sidebar: SIDEBAR_COLLAPSED,
      center: DETAILS_MIN + CENTER_MIN - 1,
      details: 0,
      rail: 0,
    })
  })

  it('tiny viewport: details closes, sidebar holds, center takes the remainder', () => {
    const cols = computeColumns(400, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(cols.details).toBe(0)
    expect(cols.sidebar).toBe(SIDEBAR_DEFAULT)
    expect(cols.center).toBe(Math.max(0, 400 - SIDEBAR_DEFAULT))
  })

  it('recovery is pure: re-widening restores preferred widths untouched', () => {
    const squeezed = computeColumns(1100, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(squeezed.details).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT))
    expect(restored.details).toBe(DETAILS_DEFAULT)
    expect(restored.sidebar).toBe(SIDEBAR_DEFAULT)
  })
})

describe('computeColumns — right rail', () => {
  it('step 1: an open rail is a fourth track and center absorbs the difference', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), closed(DETAILS_DEFAULT), open(RAIL_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 1920 - SIDEBAR_DEFAULT - RAIL_DEFAULT, details: 0, rail: RAIL_DEFAULT })
  })

  it('the rail shares the sidebar width family and clamps into it', () => {
    expect(computeColumns(1920, open(SIDEBAR_DEFAULT), closed(0), open(9999)).rail).toBe(RAIL_MAX)
    expect(computeColumns(1920, open(SIDEBAR_DEFAULT), closed(0), open(1)).rail).toBe(RAIL_MIN)
    expect(RAIL_MIN).toBe(SIDEBAR_MIN)
    expect(RAIL_MAX).toBe(SIDEBAR_MAX)
    expect(RAIL_DEFAULT).toBe(SIDEBAR_DEFAULT)
  })

  it('step 2: the rail shrinks toward its floor while center pins at min', () => {
    // 280 + 0 + 280 + 640 = 1200 fits; one pixel under it, the rail gives back 1px.
    const seam = computeColumns(SIDEBAR_DEFAULT + RAIL_DEFAULT + CENTER_MIN, open(SIDEBAR_DEFAULT), 0, open(RAIL_DEFAULT))
    expect(seam).toEqual({ sidebar: SIDEBAR_DEFAULT, center: CENTER_MIN, details: 0, rail: RAIL_DEFAULT })
    const squeezed = computeColumns(SIDEBAR_DEFAULT + RAIL_DEFAULT + CENTER_MIN - 10, open(SIDEBAR_DEFAULT), 0, open(RAIL_DEFAULT))
    expect(squeezed).toEqual({ sidebar: SIDEBAR_DEFAULT, center: CENTER_MIN, details: 0, rail: RAIL_DEFAULT - 10 })
  })

  it('step 3: the rail auto-closes before details is ever asked to concede', () => {
    // Rail open + details open starves center, but dropping the rail alone is
    // enough: chrome concedes before the panel the reader opened.
    const cols = computeColumns(1440, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RAIL_DEFAULT))
    expect(cols).toEqual({ sidebar: SIDEBAR_DEFAULT, center: 1440 - SIDEBAR_DEFAULT - DETAILS_DEFAULT, details: DETAILS_DEFAULT, rail: 0 })
  })

  it('the rail only goes silent after its own floor is not enough', () => {
    // 280 + 360 + 264 + 640 = 1544: the narrowest frame where every column keeps
    // its contract floor and preferred width at once.
    const widest = SIDEBAR_DEFAULT + DETAILS_DEFAULT + RAIL_MIN + CENTER_MIN
    const floor = computeColumns(widest, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RAIL_DEFAULT))
    expect(floor).toEqual({ sidebar: SIDEBAR_DEFAULT, center: CENTER_MIN, details: DETAILS_DEFAULT, rail: RAIL_MIN })
    // One pixel narrower: the rail is gone, and details keeps the width it had —
    // the rail concedes, the panel the reader opened does not.
    const below = computeColumns(widest - 1, open(SIDEBAR_DEFAULT), open(DETAILS_DEFAULT), open(RAIL_DEFAULT))
    expect(below).toEqual({
      sidebar: SIDEBAR_DEFAULT,
      center: 1543 - SIDEBAR_DEFAULT - DETAILS_DEFAULT,
      details: DETAILS_DEFAULT,
      rail: 0,
    })
  })

  it('a closed rail is zero width, not a compact rail: there is no 56px right state', () => {
    const cols = computeColumns(1920, open(SIDEBAR_DEFAULT), 0, closed(RAIL_DEFAULT))
    expect(cols.rail).toBe(0)
    expect(cols.rail).not.toBe(SIDEBAR_COLLAPSED)
  })

  it('recovery is pure: re-widening restores the rail at its preferred width', () => {
    const squeezed = computeColumns(1000, open(SIDEBAR_COLLAPSED), closed(0), open(RAIL_DEFAULT))
    expect(squeezed.rail).toBe(0)
    const restored = computeColumns(1920, open(SIDEBAR_COLLAPSED), closed(0), open(RAIL_DEFAULT))
    expect(restored.rail).toBe(RAIL_DEFAULT)
  })

  it('a viewport that cannot hold rail and center still closes the rail and keeps the chat', () => {
    // 700px landscape: the rail cannot exist beside a CENTER_MIN chat, so the
    // chat keeps everything the sidebar leaves (the chain closes the rail; no
    // new breakpoint decides it).
    const cols = computeColumns(700, closed(0), closed(0), open(RAIL_DEFAULT))
    expect(cols.rail).toBe(0)
    expect(cols.center).toBe(700 - SIDEBAR_COLLAPSED)
  })
})

describe('measured chat comfort — the numbers the ticket asks to report', () => {
  // --dsh-chat-content-width: 748px, the transcript's own max width
  // (packages/client/ui-conversation/src/client/skeleton/ConversationRoot.module.css:22).
  // The center track must stay at least that wide for the chat to keep its full
  // measure; anything above it is gutter the message column centers into.
  const CHAT_CONTENT_WIDTH = 748

  it('1440 landscape, details closed (the default): rail open 880 vs closed 1160', () => {
    const openLayout = computeFrameLayout(1440, 900, SIDEBAR_DEFAULT, 0, RAIL_DEFAULT)
    const closedLayout = computeFrameLayout(1440, 900, SIDEBAR_DEFAULT, 0, 0)
    expect(closedLayout.columns.center).toBe(1160)
    expect(openLayout.columns.center).toBe(880)
    expect(openLayout.columns.rail).toBe(RAIL_DEFAULT)
    // The rail costs exactly its own width, and the chat keeps its full measure.
    expect(closedLayout.columns.center - openLayout.columns.center).toBe(RAIL_DEFAULT)
    expect(openLayout.columns.center).toBeGreaterThanOrEqual(CHAT_CONTENT_WIDTH)
    // The tracks add up to the frame: no overflow, no gap.
    expect(openLayout.columns.sidebar + openLayout.columns.center + openLayout.columns.details + openLayout.columns.rail).toBe(1440)
  })

  it('1440 landscape with the details panel open: the rail auto-closes (center 800)', () => {
    // 280 + 360 + 280 + 640 = 1560 > 1440, so the chain drops the rail rather
    // than squeeze the chat under CENTER_MIN or evict the open panel.
    for (const rail of [0, RAIL_DEFAULT]) {
      const layout = computeFrameLayout(1440, 900, SIDEBAR_DEFAULT, DETAILS_DEFAULT, rail)
      expect(layout.columns).toEqual({
        sidebar: SIDEBAR_DEFAULT,
        center: 800,
        details: DETAILS_DEFAULT,
        rail: 0,
      })
      expect(layout.columns.center).toBeGreaterThanOrEqual(CHAT_CONTENT_WIDTH)
    }
  })

  it('390 portrait: the rail is never a track, so the chat cannot overflow', () => {
    const layout = computeFrameLayout(390, 844, SIDEBAR_DEFAULT, DETAILS_DEFAULT, RAIL_DEFAULT)
    expect(layout.columns).toEqual({ sidebar: 0, center: 390, details: 0, rail: 0 })
    expect(layout.columns.sidebar + layout.columns.center + layout.columns.details + layout.columns.rail).toBe(390)
  })
})

describe('computeColumns — degenerate viewports', () => {
  it('sidebar closed and viewport below CENTER_MIN: details auto-closes, center takes the rest', () => {
    // Reaches step 3's auto-close with the compact rail sidebar.
    expect(computeColumns(500, closed(300), open(DETAILS_DEFAULT)))
      .toEqual({ sidebar: SIDEBAR_COLLAPSED, center: 500 - SIDEBAR_COLLAPSED, details: 0, rail: 0 })
  })
})

describe('isPortrait', () => {
  it('is true only when the frame is taller than it is wide', () => {
    expect(isPortrait(390, 844)).toBe(true)
    expect(isPortrait(800, 1200)).toBe(true)
    expect(isPortrait(1200, 800)).toBe(false)
    expect(isPortrait(1280, 900)).toBe(false)
  })

  it('a square frame is landscape: the strict comparison keeps the old contract', () => {
    expect(isPortrait(900, 900)).toBe(false)
    expect(isPortrait(900, 901)).toBe(true)
  })

  it('an unknown height (0, as an unlaid-out frame reports) is landscape', () => {
    expect(isPortrait(800, 0)).toBe(false)
  })
})

describe('planPortrait', () => {
  it('is inert in landscape: no width, no full-frame menu', () => {
    expect(planPortrait(1280, 900)).toEqual({ portrait: false, width: 0, fullscreen: false })
  })

  it('gives a desktop-portrait frame a widened floating column, above the landscape clamp', () => {
    const plan = planPortrait(800, 1200)
    expect(plan.portrait).toBe(true)
    expect(plan.fullscreen).toBe(false)
    expect(plan.width).toBe(Math.round(800 * SIDEBAR_PORTRAIT_RATIO))
    expect(plan.width).toBe(496)
    // The point of the portrait contract: wider than the landscape drag clamp.
    expect(plan.width).toBeGreaterThan(SIDEBAR_MAX)
  })

  it('caps the floating width at its ceiling and widens from the mobile seam', () => {
    expect(planPortrait(2400, 3000)).toMatchObject({ width: SIDEBAR_PORTRAIT_MAX, fullscreen: false })
    expect(planPortrait(700, 2000).width).toBe(Math.round(700 * SIDEBAR_PORTRAIT_RATIO))
    expect(planPortrait(PORTRAIT_MOBILE_MAX + 1, 1200)).toEqual({
      portrait: true,
      width: Math.round((PORTRAIT_MOBILE_MAX + 1) * SIDEBAR_PORTRAIT_RATIO),
      fullscreen: false,
    })
  })

  it('turns the expanded column into a full-frame menu at mobile portrait widths', () => {
    expect(planPortrait(PORTRAIT_MOBILE_MAX, 844)).toEqual({ portrait: true, width: 600, fullscreen: true })
    expect(planPortrait(390, 844)).toEqual({ portrait: true, width: 390, fullscreen: true })
  })
})

describe('computeFrameLayout — landscape is untouched', () => {
  const cases: [number, number, number, number][] = [
    [1920, 1080, SIDEBAR_DEFAULT, DETAILS_DEFAULT],
    [1250, 800, SIDEBAR_DEFAULT, DETAILS_DEFAULT],
    [980, 800, SIDEBAR_DEFAULT, DETAILS_DEFAULT],
    [980, 800, 0, 0],
    [800, 600, 0, DETAILS_DEFAULT],
    [2560, 1440, 400, 500],
  ]

  it('returns exactly computeColumns for every landscape frame', () => {
    for (const [width, height, sidebar, details] of cases) {
      expect(computeFrameLayout(width, height, sidebar, details)).toEqual({
        columns: computeColumns(width, sidebar, details),
        portrait: { portrait: false, width: 0, fullscreen: false },
      })
    }
  })
})

describe('computeFrameLayout — portrait overlays the chat', () => {
  it('gives the sidebar no track, so the chat keeps the whole frame width', () => {
    const layout = computeFrameLayout(800, 1200, SIDEBAR_DEFAULT, 0)
    expect(layout.columns).toEqual({ sidebar: 0, center: 800, details: 0, rail: 0 })
    expect(layout.portrait.portrait).toBe(true)
    expect(layout.portrait.width).toBe(496)
  })

  it('the sidebar preference cannot squeeze a portrait chat', () => {
    for (const sidebar of [0, SIDEBAR_MIN, SIDEBAR_DEFAULT, SIDEBAR_MAX]) {
      expect(computeFrameLayout(800, 1200, sidebar, 0).columns).toEqual({ sidebar: 0, center: 800, details: 0, rail: 0 })
    }
  })

  it('mobile portrait: the chat still owns the full frame, the panel takes all of it', () => {
    const layout = computeFrameLayout(390, 844, SIDEBAR_DEFAULT, 0)
    expect(layout.columns).toEqual({ sidebar: 0, center: 390, details: 0, rail: 0 })
    expect(layout.portrait).toEqual({ portrait: true, width: 390, fullscreen: true })
  })

  it('details still concedes and auto-closes on a portrait frame', () => {
    // 1000 - 360 = 640 = CENTER_MIN: details keeps its width on the seam.
    expect(computeFrameLayout(1000, 1200, SIDEBAR_DEFAULT, DETAILS_DEFAULT).columns)
      .toEqual({ sidebar: 0, center: CENTER_MIN, details: DETAILS_DEFAULT, rail: 0 })
    // 980 - 360 = 620 < CENTER_MIN: details shrinks to the largest floor that
    // still leaves the center at its minimum, then center pins at CENTER_MIN.
    expect(computeFrameLayout(980, 1200, SIDEBAR_DEFAULT, DETAILS_DEFAULT).columns)
      .toEqual({ sidebar: 0, center: CENTER_MIN, details: 340, rail: 0 })
    // 700 - 300 = 400 < CENTER_MIN: details closes, center takes the frame.
    expect(computeFrameLayout(700, 1200, SIDEBAR_DEFAULT, DETAILS_DEFAULT).columns)
      .toEqual({ sidebar: 0, center: 700, details: 0, rail: 0 })
  })
})
