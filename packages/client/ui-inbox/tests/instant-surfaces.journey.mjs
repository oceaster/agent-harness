// The measurement for ticket 57a630b3's harness-app half: moving around the
// Agent-Harness workspace must cost NO document load, no iframe navigation and
// no remount, and a surface switch must paint inside one frame budget.
//
// This is not a unit test: it drives e-server's real composed shell
// (tests/browser_profiles.sh — isolated nginx, PIN, a real DSH build, a real
// session) so the numbers come from the surface Owen actually uses.
//
// Run it through the fixture, pointing at the build to measure:
//
//   EASTER_HARNESS_ROOT=/root/deepseek-harness-worktrees/57a630b3 \
//   EASTER_BROWSER_TEST=<this file> \
//   /root/e-server/tests/browser_profiles.sh
//
// THE INSTRUMENTS, named because the ticket asks which they are:
//   - DOCUMENT LOADS: Playwright's `request` events with resourceType
//     'document', plus `framenavigated` for every frame. A page load or an
//     iframe src change shows up in both; a visibility flip shows up in neither.
//   - INTENT -> PAINT: in the app frame, a `message` listener installed by
//     `addInitScript` (document_start, before the plugin's own listener) stamps
//     `performance.now()` when the parent's `dsh:open` arrives; a
//     requestAnimationFrame loop then resolves with the first frame timestamp at
//     which the target pane is unhidden with a real layout box. Both numbers are
//     from the APP's clock, so cross-document skew is not part of the result.
//   - LONG TASKS: a PerformanceObserver for 'longtask' inside the app frame,
//     reported with every switch and as a journey total.
//   - FRAME PACING: a rAF sampler in the app frame; p95 interval and the count
//     of intervals longer than 1.5 frames (24ms) while idle, visible and hidden.
//   - WHAT KEEPS RUNNING WHILE HIDDEN: the parent counts the app's own
//     `/v1/browser/` requests per window (visible inbox surface, visible epsilon
//     surface, frame hidden by the parent).
import assert from 'node:assert/strict'
import {mkdir} from 'node:fs/promises'
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || '/root/deepseek-harness/node_modules/.pnpm/playwright@1.61.1/node_modules/playwright/index.mjs')
const main = 'http://127.0.0.1:18095'
const dsh = 'http://127.0.0.1:18094'
const ACCOUNT = ['oceaster', 'owen-password']
const OUTPUT = process.env.EASTER_REVIEW_OUTPUT || '/tmp/instant-surfaces'
await mkdir(OUTPUT, {recursive: true})

for (const url of [main, dsh]) {
  let ready = false
  for (let n = 0; n < 100; n++) {
    try { const r = await fetch(url); if (r.status < 500) { ready = true; break } } catch {}
    await new Promise(resolve => setTimeout(resolve, 200))
  }
  assert(ready, 'Fixture did not start: ' + url)
}

const browser = await chromium.launch({executablePath: '/usr/bin/chromium', args: ['--no-sandbox']})
const context = await browser.newContext({viewport: {width: 1280, height: 800}})
// Installed in EVERY frame at document_start. The harness app is the only frame
// that gets a `dsh:open`, so the stamp below is the app's own arrival time.
await context.addInitScript(() => {
  const state = {intentAt: null, longs: [], intents: 0}
  window.__dshJ = state
  try {
    new PerformanceObserver(list => {
      for (const entry of list.getEntries()) state.longs.push({start: entry.startTime, duration: entry.duration})
    }).observe({entryTypes: ['longtask']})
  } catch {}
  window.addEventListener('message', (event) => {
    const data = event.data
    if (data !== null && typeof data === 'object' && data.type === 'dsh:open') {
      state.intentAt = performance.now()
      state.intents += 1
    }
  })
  /** Resolve with the first rAF timestamp at which `selector` is painted. */
  state.paintWhen = selector => new Promise((resolve) => {
    const step = (t) => {
      const node = document.querySelector(selector)
      const pane = node === null ? null : node.closest('[data-surface]')
      if (node !== null && pane !== null && pane.hidden !== true && node.getBoundingClientRect().width > 0) resolve(t)
      else requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  /** rAF timestamps for `ms` milliseconds. */
  state.pace = ms => new Promise((resolve) => {
    const times = []
    const t0 = performance.now()
    const step = (t) => {
      times.push(t)
      if (t - t0 < ms) requestAnimationFrame(step)
      else resolve(times)
    }
    requestAnimationFrame(step)
  })
})
const page = await context.newPage()
const documents = []
const navigations = []
const requests = []
const errors = []
page.on('request', (request) => {
  if (request.resourceType() === 'document') documents.push(request.url())
  if (request.url().includes('/v1/browser/')) requests.push({at: Date.now(), url: request.url(), method: request.method()})
})
page.on('framenavigated', (frame) => navigations.push({url: frame.url(), at: Date.now()}))
page.on('pageerror', error => errors.push(error.message))

const since = (list, mark) => list.filter(entry => entry.at >= mark)
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const summary = lines => {
  console.log('\n── ' + lines.join('\n── '))
}

/** Sign in through the PIN and the Easter Company account (fixture only). */
async function signIn() {
  await page.goto(main)
  await page.locator('#pin-input').fill('1234')
  await page.locator('#pin-submit').click()
  await page.locator('#account-identifier').waitFor({timeout: 15000})
  await page.locator('#account-identifier').fill(ACCOUNT[0])
  await page.locator('#account-password').fill(ACCOUNT[1])
  await page.getByRole('button', {name: 'Sign in', exact: true}).click()
  await page.locator('summary[aria-label="Account menu for Owen"]').waitFor()
}

/** The harness app frame (cross-origin: everything below goes through CDP). */
async function appFrame() {
  const handle = await page.locator('#app-frame').elementHandle({timeout: 30000})
  const frame = await handle.contentFrame()
  assert(frame !== null, 'the harness frame did not attach')
  return frame
}

/**
 * The parent's job, exactly as the e-server half will do it: post one frozen
 * `dsh:open` at the frame with an exact target origin (never '*').
 * @param surface - which interface to show.
 * @param conversation - agent to open, or null.
 * @param app - the app frame, for the intent->paint measurement.
 * @param paintedSelector - the node whose paint ends the measurement.
 * @returns the measured intent->paint milliseconds and the long tasks in it.
 */
async function open(surface, conversation, app, paintedSelector) {
  const marker = await app.evaluate(() => window.__dshJ.longs.length)
  const before = await app.evaluate(() => window.__dshJ.intentAt)
  await page.evaluate(([surface, conversation, origin]) => {
    const frame = document.getElementById('app-frame')
    frame.contentWindow.postMessage({type: 'dsh:open', surface, conversation, token: 'journey'}, origin)
  }, [surface, conversation, dsh])
  const intentAt = await app.evaluate(previous => (window.__dshJ.intentAt === previous ? null : window.__dshJ.intentAt), before)
  assert(intentAt !== null, `the app did not receive dsh:open for ${surface}/${conversation}`)
  const painted = await app.evaluate(selector => window.__dshJ.paintWhen(selector), paintedSelector)
  const longs = await app.evaluate(marker => window.__dshJ.longs.slice(marker), marker)
  return {ms: painted - intentAt, longs}
}

/** rAF pacing over `ms`, summarised. */
async function pacing(app, ms) {
  const times = await app.evaluate(ms => window.__dshJ.pace(ms), ms)
  const intervals = times.slice(1).map((t, i) => t - times[i]).sort((a, b) => a - b)
  const pick = q => intervals[Math.min(intervals.length - 1, Math.floor(intervals.length * q))]
  return {
    frames: times.length,
    p50: Number(pick(0.5).toFixed(2)),
    p95: Number(pick(0.95).toFixed(2)),
    max: Number(intervals.at(-1).toFixed(2)),
    dropped: intervals.filter(interval => interval > 24).length,
  }
}

const results = {}
try {
  await signIn()
  await page.goto(main + '/ai/harness')
  await page.locator('#app-frame').waitFor()
  let app = await appFrame()
  await app.waitForFunction(() => document.querySelector('[data-testid="ui-inbox-panel"]') !== null, null, {timeout: 40000})
  const loadsAfterColdStart = documents.length
  const navigationsAfterColdStart = navigations.length
  assert.equal(loadsAfterColdStart, 2, 'a cold /ai/harness load is the page document plus the frame document: ' + JSON.stringify(documents))

  // The parent's handshake: its initial state. The app answers dsh:ready and
  // from here both interfaces are resident.
  await open('inbox', null, app, '[data-testid="ui-inbox-panel"]')
  await page.waitForFunction(() => {
    const frame = document.getElementById('app-frame')
    return frame !== null
  })
  const resident = await app.evaluate(() => document.querySelector('[data-testid="ui-surface-epsilons"]') !== null)
  assert(resident, 'after one dsh:open both interfaces must be mounted (resident)')

  // ── (b) surface switches, measured one by one ────────────────────────────
  const switches = []
  switches.push({label: 'inbox -> epsilons', ...await open('epsilons', null, app, '[data-testid="ui-epsilon-panel"]')})
  switches.push({label: 'epsilons -> inbox', ...await open('inbox', null, app, '[data-testid="ui-inbox-panel"]')})
  switches.push({label: 'inbox -> epsilons (again)', ...await open('epsilons', null, app, '[data-testid="ui-epsilon-panel"]')})
  switches.push({label: 'epsilons -> inbox (again)', ...await open('inbox', null, app, '[data-testid="ui-inbox-panel"]')})

  // ── the ten-step journey: rows, workers and surfaces, no reloads ─────────
  const clickInApp = async (selector) => {
    const box = await app.locator(selector).boundingBox()
    if (box === null) return false
    await page.mouse.click(box.x, box.y)
    return true
  }
  const opened = []
  // A menu entry is an ADDRESS the parent can post instead of loading
  // /ai/harness/c/<agent>: the same open a click runs, by message.
  switches.push({label: 'message: open darwin', ...await open('inbox', 'darwin', app, '[data-testid="ui-inbox-open-darwin"][aria-current="true"]')})
  for (const agent of ['delta', 'darwin', 'diana', 'delta', 'darwin', 'diana']) {
    const ok = await clickInApp(`[data-testid="ui-inbox-open-${agent}"]`)
    if (ok) opened.push(agent)
    await pause(120)
  }
  switches.push({label: 'inbox -> epsilons (mid-journey)', ...await open('epsilons', null, app, '[data-testid="ui-epsilon-panel"]')})
  const workerOpen = await app.locator('[data-testid^="ui-epsilon-open-"]').first().boundingBox()
  const readOnly = {}
  if (workerOpen !== null) {
    await page.mouse.click(workerOpen.x, workerOpen.y)
    await pause(600)
    // A worker conversation is read-only by construction: no composer, no
    // header bar, and no row menu to clear it from.
    readOnly.composer = await app.evaluate(() => document.querySelectorAll('textarea').length)
    readOnly.menu = await app.evaluate(() => document.querySelectorAll('[data-testid^="ui-epsilon-menu-"]').length)
  }
  switches.push({label: 'epsilons -> inbox (mid-journey)', ...await open('inbox', null, app, '[data-testid="ui-inbox-panel"]')})
  for (const agent of ['delta', 'diana']) {
    const ok = await clickInApp(`[data-testid="ui-inbox-open-${agent}"]`)
    if (ok) opened.push(agent)
    await pause(120)
  }

  // ── (a) zero document loads across the whole journey ─────────────────────
  results.journey = {
    documentLoads: documents.length - loadsAfterColdStart,
    frameNavigations: navigations.length - navigationsAfterColdStart,
    intents: switches.length,
    conversationsOpened: opened.length,
  }

  // ── (c) a draft survives a trip to another agent and back ────────────────
  await clickInApp('[data-testid="ui-inbox-open-delta"]')
  await pause(400)
  const draft = 'draft survives a trip'
  await app.locator('textarea').first().click()
  await page.keyboard.type(draft)
  await pause(200)
  await clickInApp('[data-testid="ui-inbox-open-diana"]')
  await pause(400)
  await clickInApp('[data-testid="ui-inbox-open-delta"]')
  await pause(600)
  results.draft = {
    typed: draft,
    restored: await app.evaluate(() => document.querySelector('textarea')?.value ?? null),
  }
  // Scroll: the fixture's seeded transcripts are two messages long, so a
  // scrollable transcript has to be produced. Report what the transcript did
  // rather than assert a position on a page that cannot scroll.
  results.scroll = await app.evaluate(() => {
    const scroller = document.querySelector('[data-conversation-scroll]')
    if (scroller === null) return {present: false}
    return {present: true, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight,
      scrollable: scroller.scrollHeight > scroller.clientHeight + 4}
  })

  // ── (d) frame pacing while idle, and what runs while hidden ──────────────
  results.pacingIdle = await pacing(app, 2000)
  const inboxVisibleAt = Date.now()
  await pause(4500)
  const inboxVisibleRequests = since(requests, inboxVisibleAt)
  await open('epsilons', null, app, '[data-testid="ui-epsilon-panel"]')
  const epsilonVisibleAt = Date.now()
  results.pacingHiddenInbox = await pacing(app, 2000)
  await pause(2000)
  const epsilonVisibleRequests = since(requests, epsilonVisibleAt)
  // The parent hides the whole frame: nothing at all may be spent on it.
  await page.evaluate(() => { document.getElementById('app-frame').style.display = 'none' })
  const hiddenAt = Date.now()
  await pause(6000)
  const hiddenRequests = since(requests, hiddenAt)
  await page.evaluate(() => { document.getElementById('app-frame').style.display = '' })
  results.whileHidden = {
    inboxSurface: {
      seconds: 4.5,
      inboxReads: inboxVisibleRequests.filter(entry => entry.url.includes('/v1/browser/inbox') && !entry.url.includes('/channels') && entry.method === 'GET').length,
      channelReads: inboxVisibleRequests.filter(entry => entry.url.includes('/channels')).length,
    },
    epsilonSurface: {
      seconds: 4,
      inboxReads: epsilonVisibleRequests.filter(entry => entry.url.includes('/v1/browser/inbox') && !entry.url.includes('/channels') && entry.method === 'GET').length,
      channelReads: epsilonVisibleRequests.filter(entry => entry.url.includes('/channels')).length,
    },
    frameHidden: {seconds: 6, requests: hiddenRequests.length},
  }

  // ── (a, second half) still zero after the whole journey ─────────────────
  results.journey.documentLoadsAfterPacing = documents.length - loadsAfterColdStart
  results.journey.frameNavigationsAfterPacing = navigations.length - navigationsAfterColdStart
  results.switches = switches
  results.readOnly = readOnly
  results.longTasks = await app.evaluate(() => window.__dshJ.longs.map(entry => Number(entry.duration.toFixed(1))))

  // ── cold loads of all three addresses still land where they should ──────
  const cold = {}
  for (const [path, testId] of [['/ai/harness', 'ui-inbox-panel'], ['/ai/harness/epsilons', 'ui-epsilon-panel']]) {
    await page.goto(main + path)
    await page.locator('#app-frame').waitFor()
    app = await appFrame()
    await app.waitForFunction(selector => document.querySelector(selector) !== null, `[data-testid="${testId}"]`, {timeout: 40000})
    cold[path] = await app.evaluate(() => ({
      inboxRows: document.querySelectorAll('[data-testid^="ui-inbox-row-"]').length,
      epsilonRows: document.querySelectorAll('[data-testid^="ui-epsilon-row-"]').length,
      channelRows: document.querySelectorAll('[data-testid^="agent-channel-"]').length,
      surface: document.querySelector('[data-surface="epsilons"]')?.hidden === false ? 'epsilons' : 'inbox',
    }))
  }
  await page.goto(main + '/ai/harness/c/diana')
  await page.locator('#app-frame').waitFor()
  app = await appFrame()
  await app.waitForFunction(() => document.querySelector('[data-testid="ui-inbox-open-diana"]')?.getAttribute('aria-current') === 'true', null, {timeout: 40000})
  cold['/ai/harness/c/diana'] = await app.evaluate(() => ({
    current: document.querySelector('[data-testid^="ui-inbox-open-"][aria-current="true"]')?.getAttribute('data-testid') ?? null,
  }))
  results.coldLoads = cold
  results.errors = errors
  await page.screenshot({path: OUTPUT + '/journey-final.png'})

  // ── the assertions the ticket makes ─────────────────────────────────────
  assert.equal(results.journey.documentLoads, 0, 'the journey loaded no document')
  assert.equal(results.journey.frameNavigations, 0, 'the journey navigated no frame')
  assert.equal(results.journey.documentLoadsAfterPacing, 0, 'still no document load after the pacing windows')
  for (const move of switches) {
    assert(move.longs.every(entry => entry.duration <= 50),
      `${move.label} ran a long task: ${JSON.stringify(move.longs)}`)
    assert(move.ms <= 34, `${move.label} painted in ${move.ms.toFixed(1)}ms, outside two frames`)
  }
  assert.equal(results.draft.restored, draft, 'the draft survived the trip')
  assert(results.pacingIdle.p95 <= 20, 'idle pacing p95 ' + results.pacingIdle.p95)
  assert.equal(results.whileHidden.frameHidden.requests, 0, 'a hidden frame spent no request')
  assert.equal(results.whileHidden.epsilonSurface.channelReads, 0, 'the channel poll stopped while the epsilon surface was showing')
  assert.equal(results.whileHidden.inboxSurface.channelReads > 0, true, 'the channel poll runs while the inbox surface is showing')
  assert.equal(results.coldLoads['/ai/harness'].surface, 'inbox')
  assert.equal(results.coldLoads['/ai/harness/epsilons'].surface, 'epsilons')
  assert(results.coldLoads['/ai/harness'].epsilonRows === 0, 'a cold inbox load mounts no sub-agent row')
  assert(results.coldLoads['/ai/harness/epsilons'].inboxRows === 0, 'a cold epsilon load mounts no agent row')
  assert.equal(results.coldLoads['/ai/harness/c/diana'].current, 'ui-inbox-open-diana')
  if (readOnly.composer !== undefined) {
    assert.equal(readOnly.composer, 0, 'a worker conversation has no composer')
    assert.equal(readOnly.menu, 0, 'a worker row has no menu')
  }
  assert.equal(errors.length, 0, 'no page errors: ' + JSON.stringify(errors))
} finally {
  summary([
    'INSTANT SURFACES — measured in e-server\'s composed browser fixture',
    'document loads across the 10-step journey: ' + JSON.stringify(results.journey),
    'per-switch intent->paint (ms) and long tasks:',
    ...(results.switches ?? []).map(move => `  ${move.label}: ${move.ms.toFixed(2)}ms, longTasks=${JSON.stringify(move.longs)}`),
    'draft: ' + JSON.stringify(results.draft),
    'scroll: ' + JSON.stringify(results.scroll),
    'pacing idle: ' + JSON.stringify(results.pacingIdle),
    'pacing with the inbox surface hidden: ' + JSON.stringify(results.pacingHiddenInbox),
    'while hidden: ' + JSON.stringify(results.whileHidden),
    'cold loads: ' + JSON.stringify(results.coldLoads),
    'worker conversation: ' + JSON.stringify(results.readOnly),
    'long tasks in the app frame (whole run): ' + JSON.stringify(results.longTasks),
    'page errors: ' + JSON.stringify(results.errors),
  ])
  const {writeFile} = await import('node:fs/promises')
  await writeFile(OUTPUT + '/measurements.json', JSON.stringify(results, null, 2))
  await browser.close()
}
