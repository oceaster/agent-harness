/**
 * Headless-Chromium proof for the portrait layout (overlay inbox, collapse on
 * selection, mobile slide-in), against the keyless `dsh web` fixture
 * (tests/fixture/start-dsh-fixture.sh). No model call, no live e-server, no
 * real harness data:
 *
 * - GET /v1/browser/inbox{,/channels} and POST /open are stubbed by Playwright
 *   route interception, so the payloads below are the whole "server".
 * - The open stub does what e-server does server-to-server: it creates that
 *   conversation on the fixture host over the loopback RPC (`session.create`
 *   with the deterministic id) before answering.
 *
 * What only a real engine can answer: the numbers. Every assertion here is a
 * measurement — track widths, column widths, computed scrim opacity, element
 * counts in the collapsed rail, where the expand button sits relative to the
 * conversation's text column, and the slide transition actually running — at
 * 390x844, 800x1200, 1200x800 and 1280x900.
 *
 * Usage: node portrait-probe.mjs <baseUrl> <outDir>
 * Exits non-zero on any failed assertion. Screenshots land in <outDir> (a
 * temporary directory; nothing here is committed).
 */
import { mkdir, writeFile } from 'node:fs/promises'
import zlib from 'node:zlib'
// Playwright is a devDependency of the web frontend package (the browser lane's
// home), so the probe resolves it from there instead of adding a second copy to
// this UI plugin.
import { chromium } from '../../../../../apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir = '/tmp/inbox-portrait-proof'] = process.argv.slice(2)
if (baseUrl === undefined) {
  console.error('usage: node portrait-probe.mjs <baseUrl> <outDir>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

const results = {}
const failures = []
function check(name, condition, detail) {
  results[name] = { ok: Boolean(condition), detail }
  if (!condition) failures.push(`${name}: ${detail ?? 'failed'}`)
}

const nowSeconds = () => Date.now() / 1000

/** React serialises `minmax(0, 1fr)` to `minmax(0px, 1fr)`; accept either spelling. */
const tracksOf = (tracks) => (tracks ?? '').replace(/minmax\(0px, 1fr\)/g, 'minmax(0, 1fr)')

/** Sub-pixel layout: a measured box within one pixel of the contract number. */
const near = (actual, expected) => typeof actual === 'number' && Math.abs(actual - expected) <= 1

/** Every row carries the fields the client's parser requires of the service. */
const row = (fields) => ({
  hasConversation: true, blank: false, lastActivityAt: nowSeconds() - 320, running: false,
  enabled: true, disabled: false, presence: 'online', completion: 0, ...fields,
})

/** Three agents, one of them working, plus one agent channel. */
const scenario = () => ({
  person: { id: 'person-portrait', name: 'Portrait Person' },
  agents: [
    row({ agent: 'agent-alpha', name: 'Alpha', sessionId: 'session-inbox-person-portrait-agent-alpha' }),
    row({
      agent: 'agent-beta', name: 'Beta', sessionId: 'session-inbox-person-portrait-agent-beta',
      running: true, presence: 'running',
    }),
    row({
      agent: 'agent-gamma', name: 'Gamma', hasConversation: false, sessionId: null,
      blank: true, lastActivityAt: null,
    }),
  ],
})

const CHANNELS = { channels: [{ id: 'delta-darwin', name: 'Delta-Darwin', agents: ['agent-alpha', 'agent-beta'] }] }

/** Loopback host RPC (the probe's own wire, not the panel's). */
async function rpc(method, payload) {
  const rpcId = `portrait-probe-${Math.random().toString(16).slice(2)}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await response.json()
  return body.result
}

/**
 * Mean brightness (0-255) of a screenshot region, decoded here rather than
 * eyeballed: "the scrim darkens the chat" is a pixel claim, so it gets a pixel
 * measurement. Chromium writes 8-bit PNGs; this reads IHDR plus the inflated,
 * un-filtered RGBA scanlines and averages the RGB channels.
 * @param buffer - PNG bytes from page.screenshot({ clip }).
 * @returns the mean of (r+g+b)/3 over every pixel, rounded to one decimal.
 */
function meanBrightness(buffer) {
  let offset = 8 // skip the PNG signature
  let width = 0
  let height = 0
  let colorType = 0
  const idat = []
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = data.readUInt32BE(0)
      height = data.readUInt32BE(4)
      colorType = data.readUInt8(9)
    } else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    offset += length + 12
  }
  // 6 = RGBA, 2 = RGB: both are 8 bits per channel with no palette.
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0
  if (channels === 0) throw new Error(`unsupported PNG colour type ${String(colorType)}`)
  const raw = zlib.inflateSync(Buffer.concat(idat))
  const stride = width * channels
  const previous = Buffer.alloc(stride)
  let total = 0
  let cursor = 0
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor]
    const line = Buffer.from(raw.subarray(cursor + 1, cursor + 1 + stride))
    cursor += stride + 1
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? line[x - channels] : 0
      const up = previous[x]
      const upLeft = x >= channels ? previous[x - channels] : 0
      if (filter === 1) line[x] = (line[x] + left) & 0xff
      else if (filter === 2) line[x] = (line[x] + up) & 0xff
      else if (filter === 3) line[x] = (line[x] + ((left + up) >> 1)) & 0xff
      else if (filter === 4) {
        const p = left + up - upLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - up)
        const pc = Math.abs(p - upLeft)
        line[x] = (line[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff
      }
    }
    line.copy(previous)
    for (let x = 0; x < stride; x += channels) total += (line[x] + line[x + 1] + line[x + 2]) / 3
  }
  return Math.round((total / (width * height)) * 10) / 10
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })

/** Boot one page whose inbox endpoints answer from the fixture payloads. */
async function openPage({ width, height, reducedMotion = false }) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'en-US',
    ...(reducedMotion ? { reducedMotion: 'reduce' } : {}),
  })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))
  const state = scenario()

  await page.route('**/v1/browser/inbox', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(state) })
  })
  await page.route('**/v1/browser/inbox/channels', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(CHANNELS) })
  })
  await page.route('**/v1/browser/inbox/channels/*/messages', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: [] }) })
  })
  await page.route('**/v1/browser/inbox/open', async (route) => {
    const { agent } = JSON.parse(route.request().postData() ?? '{}')
    const sessionId = `session-inbox-person-portrait-${agent}`
    await rpc('session.create', { sessionId }).catch(() => {})
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agent, sessionId, created: true, blank: true, lastActivityAt: null }),
    })
  })
  await page.route('**/v1/browser/inbox/clear', async (route) => {
    const { agent } = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        agent, hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true,
      }),
    })
  })

  await page.goto(baseUrl, { waitUntil: 'load' })
  const notice = page.getByRole('button', { name: 'Continue' })
  if (await notice.count() > 0) await notice.click()
  await page.getByTestId('ui-inbox-panel').or(page.getByTestId('ui-inbox-rail')).first().waitFor({ timeout: 30_000 })
  return { context, page, consoleErrors }
}

/**
 * One geometry reading of the live frame: every number the ticket asks for.
 * Runs inside the page, so it reads the same computed styles the paint uses.
 */
async function measure(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('[data-shell-overlay]')
    const frame = overlay?.parentElement
    if (!(frame instanceof HTMLElement)) throw new Error('frame not found')
    const sidebar = frame.querySelector('[class*="sidebarCol"]')
    const center = frame.querySelector('[class*="centerCol"]')
    const scrimNode = frame.querySelector('[data-testid="ui-layout-scrim"]')
    const expand = document.querySelector('[data-testid="ui-sidebar-expand"]')
    const rail = document.querySelector('[data-testid="ui-inbox-rail"]')
    const width = (node) => (node instanceof Element ? Math.round(node.getBoundingClientRect().width) : null)
    const text = (selector) => Array.from(frame.querySelectorAll(selector))
    const count = (selector) => text(selector).length

    let scrim = null
    if (scrimNode instanceof Element) {
      const style = getComputedStyle(scrimNode)
      const rect = scrimNode.getBoundingClientRect()
      const panelWidth = sidebar instanceof Element ? sidebar.getBoundingClientRect().width : 0
      // The chat the panel does not cover. A full-frame panel (mobile portrait)
      // leaves none, so there is no visible chat pixel to sample: the scrim is
      // then "painted" by its own geometry and stack position instead.
      const visibleChat = Math.round(rect.width - panelWidth)
      const sampleX = Math.min(rect.right - 8, rect.left + panelWidth + 24)
      const sampleY = rect.top + Math.round(rect.height / 2)
      const topmost = visibleChat >= 24 ? document.elementFromPoint(sampleX, sampleY) : null
      scrim = {
        opacity: Number(style.opacity),
        backgroundColor: style.backgroundColor,
        zIndex: style.zIndex,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        visibleChat,
        samplePoint: visibleChat >= 24 ? { x: Math.round(sampleX), y: Math.round(sampleY) } : null,
        coversChat: visibleChat >= 24 ? topmost === scrimNode : null,
        topmostAtChatPoint: topmost instanceof Element
          ? (topmost.getAttribute('data-testid') ?? topmost.className ?? topmost.tagName)
          : null,
      }
    }

    const rectOf = (node) => {
      if (!(node instanceof Element)) return null
      const r = node.getBoundingClientRect()
      return { left: Math.round(r.left), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), width: Math.round(r.width), height: Math.round(r.height) }
    }

    return {
      portrait: frame.hasAttribute('data-portrait'),
      portraitOverlay: frame.hasAttribute('data-portrait-overlay'),
      portraitMobile: frame.hasAttribute('data-portrait-mobile'),
      collapsed: frame.hasAttribute('data-sidebar-collapsed'),
      detailsCollapsed: frame.hasAttribute('data-details-collapsed'),
      tracks: frame.style.gridTemplateColumns,
      sidebarWidth: width(sidebar),
      chatWidth: width(center),
      chatRect: rectOf(center),
      scrim,
      expand: rectOf(expand),
      expandLabel: expand instanceof Element ? expand.getAttribute('aria-label') : null,
      sidebarFill: sidebar instanceof Element ? getComputedStyle(sidebar).backgroundColor : null,
      dragHandles: count('[class*="handle"]'),
      rail: {
        present: rail !== null,
        glyphs: count('[data-testid^="ui-inbox-rail-"]') + count('[data-testid^="agent-channel-rail-"]'),
        panel: count('[data-testid="ui-inbox-panel"]'),
        stateLines: count('[data-testid^="ui-inbox-state-"]'),
        menus: count('[data-testid^="ui-inbox-menu-"]'),
        rows: count('[data-testid^="ui-inbox-row-"]'),
        refresh: count('[data-testid="ui-inbox-refresh"]'),
        text: sidebar instanceof Element ? sidebar.innerText.trim() : null,
      },
      focusable: Array.from(frame.querySelectorAll('a[href], button, input, select, textarea, [tabindex]'))
        .filter(node => !node.hasAttribute('disabled') && node.getAttribute('tabindex') !== '-1')
        .map(node => ({
          testid: node.getAttribute('data-testid'),
          label: node.getAttribute('aria-label'),
          visible: typeof node.checkVisibility === 'function' ? node.checkVisibility() : true,
        })),
    }
  })
}

/** Tab through the document and report what the keyboard actually reaches. */
async function tabOrder(page, steps) {
  const seen = []
  await page.evaluate(() => { document.body.tabIndex = -1; document.body.focus() })
  for (let index = 0; index < steps; index += 1) {
    await page.keyboard.press('Tab')
    seen.push(await page.evaluate(() => {
      const node = document.activeElement
      if (!(node instanceof Element)) return { tag: 'none' }
      const rect = node.getBoundingClientRect()
      return {
        tag: node.tagName,
        testid: node.getAttribute('data-testid'),
        label: node.getAttribute('aria-label'),
        visible: typeof node.checkVisibility === 'function' ? node.checkVisibility() : true,
        onScreen: rect.width > 0 && rect.height > 0,
      }
    }))
  }
  return seen
}

// ── portrait viewports ───────────────────────────────────────────────────────
for (const vp of [{ name: 'mobile-390x844', width: 390, height: 844 }, { name: 'desktop-800x1200', width: 800, height: 1200 }]) {
  const { context, page, consoleErrors } = await openPage(vp)
  const tag = `${vp.name}`

  // 1. Collapsed (portrait's default): transparent overlay rail, chat full width.
  const collapsed = await measure(page)
  check(`${tag}: portrait detected (width < height)`, collapsed.portrait === true && collapsed.portraitOverlay === false, JSON.stringify({ portrait: collapsed.portrait, overlay: collapsed.portraitOverlay }))
  check(`${tag}: collapsed portrait starts at the rail`, collapsed.collapsed === true && near(collapsed.sidebarWidth, 56), JSON.stringify({ collapsed: collapsed.collapsed, sidebarWidth: collapsed.sidebarWidth }))
  check(`${tag}: the sidebar owns no grid track; the chat takes the frame`,
    tracksOf(collapsed.tracks) === '0px minmax(0, 1fr) 0px' && near(collapsed.chatWidth, vp.width),
    JSON.stringify({ tracks: collapsed.tracks, chatWidth: collapsed.chatWidth }))
  check(`${tag}: no scrim while collapsed`, collapsed.scrim === null)
  check(`${tag}: the collapsed column paints no fill`, collapsed.sidebarFill === 'rgba(0, 0, 0, 0)', collapsed.sidebarFill)
  check(`${tag}: collapsed rail renders glyphs only`, collapsed.rail.present && collapsed.rail.glyphs === 4, JSON.stringify(collapsed.rail))
  check(`${tag}: collapsed rail renders no header, menu, state line, row, refresh or timestamp`,
    collapsed.rail.panel === 0 && collapsed.rail.stateLines === 0 && collapsed.rail.menus === 0
      && collapsed.rail.rows === 0 && collapsed.rail.refresh === 0 && !/Working|ago|Inbox|Settings|Refresh/.test(collapsed.rail.text ?? ''),
    JSON.stringify({ text: collapsed.rail.text, rail: collapsed.rail }))
  check(`${tag}: the expand control floats in the left margin under an inbox name`,
    collapsed.expand !== null && collapsed.expand.right <= 56 && collapsed.expandLabel === 'Expand inbox',
    JSON.stringify(collapsed.expand))
  check(`${tag}: no sidebar resize handle in portrait`, collapsed.dragHandles === 0, String(collapsed.dragHandles))

  // 2. Keyboard: everything tabbable in the collapsed state is on screen.
  const tabs = await tabOrder(page, 8)
  const offscreen = tabs.filter(entry => entry.tag !== 'none' && (!entry.visible || !entry.onScreen))
  check(`${tag}: no tab stop on a control that is not painted`, offscreen.length === 0, JSON.stringify(tabs))
  const hiddenSurface = tabs.filter(entry => /ui-inbox-(state|menu|refresh|panel)|ui-inbox-row-/.test(entry.testid ?? ''))
  check(`${tag}: the tab order never enters a surface the rail does not render`, hiddenSurface.length === 0, JSON.stringify(tabs.map(t => t.testid ?? t.label ?? t.tag)))
  results[`${tag} tab order`] = tabs.map(entry => entry.testid ?? entry.label ?? entry.tag)

  await page.screenshot({ path: `${outDir}/${tag}-1-collapsed.png` })

  // 3. Expand: same chat width, dimming scrim, widened floating panel.
  // The chat region this viewport will leave uncovered once the panel is open:
  // sampled before and after so the "darkens" claim is measured in pixels.
  const panelWidth = vp.width <= 600 ? vp.width : Math.round(vp.width * 0.62)
  const chatClip = vp.width - panelWidth >= 60
    ? { x: panelWidth + 12, y: 100, width: vp.width - panelWidth - 24, height: vp.height - 200 }
    : null
  const collapsedBrightness = chatClip === null ? null : meanBrightness(await page.screenshot({ clip: chatClip }))

  await page.getByTestId('ui-sidebar-expand').click()
  await page.getByTestId('ui-inbox-panel').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(450) // let the 300ms slide settle so widths are final
  const expanded = await measure(page)
  const expandedBrightness = chatClip === null ? null : meanBrightness(await page.screenshot({ clip: chatClip }))
  check(`${tag}: expanding does not squeeze the chat`, near(expanded.chatWidth, collapsed.chatWidth), JSON.stringify({ collapsed: collapsed.chatWidth, expanded: expanded.chatWidth }))
  check(`${tag}: the sidebar track stays zero when expanded`, tracksOf(expanded.tracks) === '0px minmax(0, 1fr) 0px', expanded.tracks)
  check(`${tag}: the floating panel takes its portrait width`, near(expanded.sidebarWidth, panelWidth), JSON.stringify({ measured: expanded.sidebarWidth, expected: panelWidth }))
  check(`${tag}: the floating panel is wider than the 420px landscape clamp`, expanded.sidebarWidth > 420 || vp.width <= 600, String(expanded.sidebarWidth))
  const scrimPainted = expanded.scrim !== null
    && (expanded.scrim.visibleChat >= 24
      // A panel narrower than the frame: the hit test over the visible chat
      // must land on the scrim, which is what "painted over the chat" means.
      ? expanded.scrim.coversChat === true
      // A full-frame panel leaves no chat showing: the scrim must span the frame.
      : near(expanded.scrim.width, vp.width) && expanded.scrim.height > 0)
  check(`${tag}: a scrim exists and covers the chat`, scrimPainted, JSON.stringify(expanded.scrim))
  check(`${tag}: the scrim dims at 0.55 opacity over a black fill`,
    expanded.scrim?.opacity === 0.55 && expanded.scrim?.backgroundColor === 'rgb(0, 0, 0)',
    JSON.stringify(expanded.scrim))
  if (chatClip !== null) {
    const ratio = Math.round((expandedBrightness / collapsedBrightness) * 1000) / 1000
    check(`${tag}: the same chat pixels are measurably darker behind the scrim`,
      expandedBrightness < collapsedBrightness * 0.6,
      JSON.stringify({ clip: chatClip, collapsedBrightness, expandedBrightness, ratio }))
    results[`${tag} darkening`] = { clip: chatClip, collapsedBrightness, expandedBrightness, ratio }
  } else {
    results[`${tag} darkening`] = 'no uncovered chat region: the panel spans the frame (the scrim sits behind it)'
  }
  await page.screenshot({ path: `${outDir}/${tag}-2-expanded.png` })

  // 4. A selection collapses the inbox without a second click (agent row).
  await page.getByTestId('ui-inbox-open-agent-beta').click()
  await page.getByTestId('ui-inbox-rail').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(250)
  const afterSelection = await measure(page)
  check(`${tag}: selecting an agent row auto-collapses the inbox`, afterSelection.collapsed === true && afterSelection.scrim === null, JSON.stringify({ collapsed: afterSelection.collapsed, tracks: afterSelection.tracks }))
  check(`${tag}: the chat keeps its width through the whole cycle`, afterSelection.chatWidth === collapsed.chatWidth, JSON.stringify({ before: collapsed.chatWidth, after: afterSelection.chatWidth }))

  // 5. The conversation's text column clears the expand button (no overlap).
  const composer = page.locator('textarea').first()
  await composer.waitFor({ timeout: 20_000 })
  const textColumn = await composer.evaluate((node) => {
    const rect = node.getBoundingClientRect()
    return { left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) }
  })
  const button = afterSelection.expand
  check(`${tag}: the expand button clears the conversation's text column`,
    button !== null && textColumn.left >= button.right,
    JSON.stringify({ button, textColumn }))
  await page.screenshot({ path: `${outDir}/${tag}-3-selection-collapsed.png` })

  // 6. A channel selection collapses it too.
  await page.getByTestId('ui-sidebar-expand').click()
  await page.getByTestId('ui-inbox-panel').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(400)
  const channelRow = page.getByTestId('agent-channel-open-delta-darwin')
  if (await channelRow.count() > 0) {
    await channelRow.click()
    await page.getByTestId('ui-inbox-rail').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(250)
    const afterChannel = await measure(page)
    check(`${tag}: selecting a channel auto-collapses the inbox`, afterChannel.collapsed === true, JSON.stringify({ collapsed: afterChannel.collapsed }))
    await page.screenshot({ path: `${outDir}/${tag}-4-channel-collapsed.png` })
  } else {
    check(`${tag}: a channel row is listed in the expanded inbox`, false, 'channel row missing')
  }

  // 7. The rail keeps row identity: names and the selected state.
  const identity = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-testid^="ui-inbox-rail-"], [data-testid^="agent-channel-rail-"]'))
    return nodes.map(node => ({
      testid: node.getAttribute('data-testid'),
      label: node.getAttribute('aria-label'),
      current: node.getAttribute('aria-current'),
    }))
  })
  check(`${tag}: every rail glyph keeps its own accessible name`,
    identity.every(item => typeof item.label === 'string' && item.label.length > 0), JSON.stringify(identity))
  results[`${tag} rail identity`] = identity
  check(`${tag}: the selected row (channel) keeps its selected state in the rail`,
    identity.some(item => item.current === 'true'), JSON.stringify(identity))

  // 8. Mobile portrait: the panel is a full-frame slide, dropped under reduced motion.
  if (vp.width <= 600) {
    const before = await measure(page)
    await page.getByTestId('ui-sidebar-expand').click()
    await page.getByTestId('ui-inbox-panel').waitFor({ timeout: 10_000 })
    await page.waitForTimeout(70)
    const mid = await measure(page)
    const running = await page.evaluate(() => {
      const sidebar = document.querySelector('[class*="sidebarCol"]')
      const scrim = document.querySelector('[data-testid="ui-layout-scrim"]')
      const of = (node) => (node instanceof Element
        ? node.getAnimations().map(animation => ({
          kind: animation.constructor.name,
          name: animation.animationName ?? null,
          property: animation.transitionProperty ?? null,
        }))
        : [])
      return { sidebar: of(sidebar), scrim: of(scrim) }
    })
    check(`${tag}: the full-frame panel slides in from the left (transform/opacity, or width, in flight)`,
      mid.sidebarWidth > before.sidebarWidth && mid.sidebarWidth < vp.width,
      JSON.stringify({ before: before.sidebarWidth, mid: mid.sidebarWidth, full: vp.width }))
    check(`${tag}: the slide is a real animation/transition on the column`,
      running.sidebar.length > 0 || running.scrim.length > 0, JSON.stringify(running))
    results[`${tag} slide animations`] = running
    await page.waitForTimeout(400)
    await page.screenshot({ path: `${outDir}/${tag}-5-slide-settled.png` })
  }

  const pageErrors = consoleErrors.filter(text => !/^Failed to load resource/.test(text))
  check(`${tag}: no page console errors`, pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 4)))
  await context.close()
}

// ── the mobile slide under prefers-reduced-motion ────────────────────────────
{
  const { context, page, consoleErrors } = await openPage({ width: 390, height: 844, reducedMotion: true })
  const start = await measure(page)
  await page.getByTestId('ui-sidebar-expand').click()
  await page.getByTestId('ui-inbox-panel').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(70)
  const mid = await measure(page)
  const running = await page.evaluate(() => {
    const sidebar = document.querySelector('[class*="sidebarCol"]')
    const scrim = document.querySelector('[data-testid="ui-layout-scrim"]')
    return {
      sidebar: sidebar instanceof Element ? sidebar.getAnimations().length : null,
      scrim: scrim instanceof Element ? scrim.getAnimations().length : null,
    }
  })
  check('reduced-motion: the panel jumps to its full width without animating',
    near(mid.sidebarWidth, 390) && mid.collapsed === false, JSON.stringify({ start: start.sidebarWidth, mid: mid.sidebarWidth }))
  check('reduced-motion: no animation or transition is left running',
    running.sidebar === 0 && running.scrim === 0, JSON.stringify(running))
  const pageErrors = consoleErrors.filter(text => !/^Failed to load resource/.test(text))
  check('reduced-motion: no page console errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 4)))
  await context.close()
}

// ── landscape viewports: the contract that must not move ─────────────────────
for (const vp of [{ name: 'landscape-1200x800', width: 1200, height: 800 }, { name: 'landscape-1280x900', width: 1280, height: 900 }]) {
  const { context, page, consoleErrors } = await openPage(vp)
  const tag = vp.name

  const open = await measure(page)
  check(`${tag}: landscape is not portrait`, open.portrait === false && open.portraitOverlay === false && open.portraitMobile === false, JSON.stringify({ portrait: open.portrait }))
  check(`${tag}: the sidebar keeps its 280px landscape track`,
    tracksOf(open.tracks) === '280px minmax(0, 1fr) 0px' && near(open.sidebarWidth, 280),
    JSON.stringify({ tracks: open.tracks, sidebarWidth: open.sidebarWidth }))
  check(`${tag}: the chat keeps the concession width`, near(open.chatWidth, vp.width - 280), JSON.stringify({ chatWidth: open.chatWidth, expected: vp.width - 280 }))
  check(`${tag}: no scrim in landscape`, open.scrim === null)
  check(`${tag}: the expanded inbox is the full panel`, open.rail.panel === 1 && open.rail.present === false, JSON.stringify(open.rail))
  check(`${tag}: the sidebar resize handle is present`, open.dragHandles === 1, String(open.dragHandles))
  check(`${tag}: the column keeps its opaque fill`, open.sidebarFill !== 'rgba(0, 0, 0, 0)', open.sidebarFill)
  await page.screenshot({ path: `${outDir}/${tag}-1-expanded.png` })

  // Collapse through the inbox header control, exactly as before.
  await page.getByRole('button', { name: 'Collapse sidebar' }).click()
  await page.getByTestId('ui-inbox-rail').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(400)
  const collapsed = await measure(page)
  check(`${tag}: collapsing lands on the 56px rail track`,
    tracksOf(collapsed.tracks) === '56px minmax(0, 1fr) 0px' && near(collapsed.sidebarWidth, 56),
    JSON.stringify({ tracks: collapsed.tracks, sidebarWidth: collapsed.sidebarWidth }))
  check(`${tag}: the rail keeps the landscape fold control`, collapsed.expandLabel === 'Open sidebar', collapsed.expandLabel)
  check(`${tag}: the collapsed rail still paints the column fill`, collapsed.sidebarFill !== 'rgba(0, 0, 0, 0)', collapsed.sidebarFill)
  check(`${tag}: no scrim while collapsed`, collapsed.scrim === null)
  await page.screenshot({ path: `${outDir}/${tag}-2-collapsed.png` })

  // A row click in landscape must NOT collapse the column any further or change it.
  await page.getByRole('button', { name: 'Open sidebar' }).click()
  await page.getByTestId('ui-inbox-panel').waitFor({ timeout: 10_000 })
  await page.waitForTimeout(400)
  await page.getByTestId('ui-inbox-open-agent-alpha').click()
  await page.waitForTimeout(900)
  const afterSelection = await measure(page)
  check(`${tag}: a selection leaves the landscape column open, as it always did`,
    afterSelection.collapsed === false && tracksOf(afterSelection.tracks) === '280px minmax(0, 1fr) 0px',
    JSON.stringify({ collapsed: afterSelection.collapsed, tracks: afterSelection.tracks }))
  check(`${tag}: the chat keeps its landscape width after a selection`, near(afterSelection.chatWidth, vp.width - 280), String(afterSelection.chatWidth))

  const pageErrors = consoleErrors.filter(text => !/^Failed to load resource/.test(text))
  check(`${tag}: no page console errors`, pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 4)))
  await context.close()
}

await browser.close()
await writeFile(`${outDir}/portrait-proof.json`, JSON.stringify({ results, failures, viewports: [] }, null, 2))
console.log(JSON.stringify({ ok: failures.length === 0, failures, results }, null, 2))
process.exit(failures.length === 0 ? 0 : 1)
