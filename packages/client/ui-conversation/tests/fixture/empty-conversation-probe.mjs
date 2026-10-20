/**
 * Headless-Chromium proof for the empty-conversation placeholder, against a
 * keyless `dsh web` fixture (tests/fixture/start-dsh-fixture.sh). No model
 * call, no live e-server, no real harness data:
 *
 * - GET/POST /v1/browser/inbox and /open are stubbed by Playwright route
 *   interception, so the payloads below are the whole "server".
 * - The open stub does what e-server does server-to-server: it creates that
 *   conversation on the fixture host over the loopback RPC (`session.create`
 *   with the deterministic id) before answering. The browser must then paint
 *   the empty conversation the server returned.
 * - The first message that proves the composer does not move is a slash
 *   command (`/goal`), which produces a transcript row with no model request.
 *
 * What only a real engine can answer is the layout the person reported: where
 * the input card sits in an empty conversation, whether it stays there when
 * the transcript starts, and whether the branded mark is actually painted.
 *
 * Usage: node empty-conversation-probe.mjs <baseUrl> <outDir>
 * Exits non-zero on any failed assertion.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
// Playwright is a devDependency of the web frontend package (the browser lane's
// home), so the probe resolves it from there instead of adding a second copy to
// this UI plugin.
import { chromium } from '../../../../../apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir = '/tmp/ui-conversation-proof'] = process.argv.slice(2)
if (baseUrl === undefined) {
  console.error('usage: node empty-conversation-probe.mjs <baseUrl> <outDir>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

const results = {}
const failures = []
function check(name, condition, detail) {
  results[name] = { ok: Boolean(condition), detail }
  if (!condition) failures.push(`${name}: ${detail ?? 'failed'}`)
}

/**
 * Conversation id for THIS run: the fixture host's session store outlives a
 * probe run, so a fixed id would reopen the transcript an earlier run left
 * behind instead of a blank conversation.
 */
const SESSION_ID = `session-inbox-probe-agent-alpha-${String(Date.now())}`

/** One agent with a blank conversation; the sidebar row is the whole inbox. */
const ONE_BLANK_AGENT = () => ({
  person: { id: 'person-empty', name: 'Empty Conversation Person' },
  agents: [{
    agent: 'agent-alpha', name: 'Alpha', hasConversation: true,
    sessionId: SESSION_ID, blank: true,
    lastActivityAt: null, running: false,
    // The row parser refuses a row it cannot spell out completely.
    presence: 'offline', completion: 0, enabled: true, disabled: false,
  }],
})

/** Loopback host RPC (the browser's own wire, used by the probe, not by the panel). */
async function rpc(method, payload) {
  const rpcId = `empty-conversation-probe-${Math.random().toString(16).slice(2)}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await response.json()
  return body.result
}

/**
 * The composer card's client box, rounded to hundredths so sub-pixel noise does
 * not read as movement: the geometry the first message must not change.
 * Self-contained because it is serialized into the page.
 * @returns the card's left edge, width, and distance from the scroll body's floor.
 */
function composerBox() {
  const round = value => Math.round(value * 100) / 100
  const card = document.querySelector('[data-composer-card]')
  const scrollBody = document.querySelector('[data-conversation-scroll]')
  if (card === null || scrollBody === null) {
    throw new Error(`composer geometry: cardMissing=${String(card === null)}, scrollBodyMissing=${String(scrollBody === null)}`)
  }
  const cardBox = card.getBoundingClientRect()
  const bodyBox = scrollBody.getBoundingClientRect()
  return { x: round(cardBox.x), width: round(cardBox.width), bottomGap: round(bodyBox.bottom - cardBox.bottom) }
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))

try {
  await page.route('**/v1/browser/inbox', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_BLANK_AGENT()) })
  })
  await page.route('**/v1/browser/inbox/open', async (route) => {
    const { agent } = JSON.parse(route.request().postData() ?? '{}')
    await rpc('session.create', { sessionId: SESSION_ID })
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agent, sessionId: SESSION_ID, created: true, blank: true, lastActivityAt: null }),
    })
  })
  // No agent channels in this fixture: the panel reads the channel list with
  // the same request it reads the agent list, and a refusal there is fatal to
  // the whole panel.
  await page.route('**/v1/browser/inbox/channels', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ channels: [] }) })
  })
  // The brand mark e-server serves at this path. The fixture host is not
  // e-server, so the probe answers with the same file when the checkout has
  // one and a stand-in path otherwise — the mask URL is what the layout reads.
  await page.route('**/v1/browser/inbox/brand.svg', async (route) => {
    const served = await readFile('/root/e-server/infra/web-app/ec-logo-2-outline.svg', 'utf8').catch(() => null)
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: served ?? '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 755 712"><path d="M0 0h755v712H0z"/></svg>',
    })
  })
  await page.route('**/v1/browser/inbox/clear', async (route) => {
    const { agent } = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agent, hasConversation: true, cleared: false }),
    })
  })

  await page.goto(baseUrl, { waitUntil: 'load' })
  const notice = page.getByRole('button', { name: 'Continue' })
  if (await notice.count() > 0) await notice.click()

  // The no-conversation welcome screen is the state this placeholder replaces.
  await page.getByTestId('inbox-welcome').waitFor({ timeout: 30_000 })
  await page.screenshot({ path: `${outDir}/01-no-conversation.png` })

  await page.getByTestId('ui-inbox-row-agent-alpha').click()
  await page.getByTestId('conversation-empty').waitFor({ timeout: 30_000 })
  await page.screenshot({ path: `${outDir}/02-empty-conversation.png` })

  const empty = await page.evaluate(() => {
    const scrollBody = document.querySelector('[data-conversation-scroll]')
    const placeholder = document.querySelector('[data-testid="conversation-empty"]')
    const seat = document.querySelector('[data-composer-seat]')
    const mark = placeholder?.querySelector('div') ?? null
    const glow = placeholder?.querySelector('svg') ?? null
    const markStyle = mark === null ? null : getComputedStyle(mark)
    return {
      phase: document.querySelector('div[data-phase]')?.getAttribute('data-phase'),
      placeholderInBody: scrollBody !== null && scrollBody.contains(placeholder),
      seatInBody: scrollBody !== null && scrollBody.contains(seat),
      placeholderBeforeSeat: placeholder !== null && seat !== null
        && placeholder.compareDocumentPosition(seat) === Node.DOCUMENT_POSITION_FOLLOWING,
      glowPainted: glow !== null && glow.getBoundingClientRect().width > 0,
      markPainted: mark !== null && mark.getBoundingClientRect().width > 0,
      markMask: markStyle === null ? null : (markStyle.maskImage || markStyle.webkitMaskImage),
      placeholderText: placeholder?.textContent ?? '',
      pageText: document.body.innerText,
      placeholderVisible: placeholder !== null
        && getComputedStyle(placeholder).visibility === 'visible'
        && placeholder.getBoundingClientRect().height > 0,
      composerPlaceholder: document.querySelector('textarea')?.getAttribute('placeholder'),
      seatPainted: seat !== null && getComputedStyle(seat).visibility === 'visible',
    }
  })
  check('empty conversation renders the branded placeholder in the conversation body',
    empty.placeholderInBody && empty.placeholderVisible && empty.phase === 'active',
    JSON.stringify({ phase: empty.phase, inBody: empty.placeholderInBody, visible: empty.placeholderVisible }))
  check('the mark is the welcome screen\'s masked brand art plus its glow',
    empty.markPainted && empty.glowPainted && typeof empty.markMask === 'string'
      && empty.markMask.includes('brand.svg'),
    JSON.stringify({ markPainted: empty.markPainted, glowPainted: empty.glowPainted, mask: empty.markMask }))
  check('the placeholder carries no text of its own',
    empty.placeholderText === '', JSON.stringify(empty.placeholderText))
  check('no empty-state headline or Preview badge anywhere on the page',
    !empty.pageText.includes('Into the Unknown') && !empty.pageText.includes('Preview'),
    JSON.stringify(empty.pageText))
  check('the composer is docked, painted, and keeps its ordinary placeholder',
    empty.seatInBody && empty.placeholderBeforeSeat && empty.seatPainted
      && empty.composerPlaceholder === 'Message the agent',
    JSON.stringify({
      seatInBody: empty.seatInBody, beforeSeat: empty.placeholderBeforeSeat,
      painted: empty.seatPainted, placeholder: empty.composerPlaceholder,
    }))

  const beforeSend = await page.evaluate(composerBox)
  await page.screenshot({ path: `${outDir}/03-empty-conversation-wide.png` })

  // First message with no model request: a claimed command renders a transcript
  // row, which is exactly the blank → transcript transition that used to move
  // the composer out of the center of the column.
  const textarea = page.locator('textarea').first()
  await textarea.fill('/goal')
  // The claimed command token completes first (`/goal `), then submits.
  await textarea.press('Enter')
  await expectPoll(async () => (await textarea.inputValue()).endsWith(' '), 10_000)
  await textarea.press('Enter')
  await expectPoll(async () => await page.getByTestId('conversation-empty').count() === 0, 15_000)
  const afterSend = await page.evaluate(composerBox)
  await page.screenshot({ path: `${outDir}/04-transcript-started.png` })
  check('the first message leaves the composer in the same place at the same size',
    Math.abs(beforeSend.x - afterSend.x) < 1
      && Math.abs(beforeSend.width - afterSend.width) < 1
      && Math.abs(beforeSend.bottomGap - afterSend.bottomGap) < 1,
    JSON.stringify({ beforeSend, afterSend }))
  check('the placeholder is gone once the transcript starts',
    await page.getByTestId('conversation-empty').count() === 0)

  // Narrow viewport: the same relations must hold where the column squeezes.
  await page.setViewportSize({ width: 480, height: 900 })
  await page.waitForTimeout(300)
  const narrow = await page.evaluate(() => {
    const scrollBody = document.querySelector('[data-conversation-scroll]')
    return {
      overflowX: getComputedStyle(scrollBody).overflowX,
      bleedRange: scrollBody.scrollWidth - scrollBody.clientWidth,
      horizontalBar: scrollBody.scrollWidth > scrollBody.clientWidth
        && getComputedStyle(scrollBody).overflowX !== 'hidden',
    }
  })
  await page.screenshot({ path: `${outDir}/05-narrow-transcript.png` })
  check('the column never grows a horizontal scrollbar',
    narrow.overflowX === 'hidden' && narrow.horizontalBar === false, JSON.stringify(narrow))

  check('no page error and no React/JS console error',
    consoleErrors.filter(text => !/^Failed to load resource/.test(text)).length === 0,
    JSON.stringify(consoleErrors))
} catch (error) {
  failures.push(`probe crashed: ${String(error)}`)
  await page.screenshot({ path: `${outDir}/99-failure.png` }).catch(() => {})
} finally {
  await writeFile(`${outDir}/results.json`, `${JSON.stringify(results, null, 2)}\n`)
  await context.close()
  await browser.close()
}

/** Playwright-free polling helper: `expect.poll` lives in the test runner, not here. */
async function expectPoll(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  return false
}

if (failures.length > 0) {
  console.error(`FAILED (${failures.length}):`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`ok: ${Object.keys(results).length} checks passed; results in ${outDir}`)
