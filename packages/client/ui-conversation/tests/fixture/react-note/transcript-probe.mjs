/**
 * Spike probe (ticket 5ef4e080) — NOT product source.
 *
 * Browser proof for the transcript half of the ticket: a reaction note must be
 * invisible to the person reading the conversation, while the model got it.
 *
 * It runs the real built web app against the keyless fixture host
 * (start-react-note-fixture.sh) and the real session that probe.mjs measured.
 * The household inbox endpoints belong to e-server, which this fixture is not,
 * so they are stubbed by Playwright route interception (same technique as
 * ../empty-conversation-probe.mjs); everything below the transcript — RPC,
 * session log, node registry, React render — is the real harness.
 *
 * Three measurements:
 *   1. the transcript settles and shows the conversation;
 *   2. appending a LOG-ONLY note leaves the transcript identical (no row,
 *      bubble, divider, timestamp or line);
 *   3. appending the USER-MESSAGE carrier adds a visible row — the leak the
 *      log-only carrier exists to avoid.
 *
 * Usage: node transcript-probe.mjs <baseUrl> <sessionId> <outDir>
 * Exits non-zero on any failed assertion.
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from '../../../../../../apps/web/node_modules/playwright/index.mjs'

const [baseUrl, sessionId, outDir = '/tmp/react-note-proof'] = process.argv.slice(2)
if (baseUrl === undefined || sessionId === undefined) {
  console.error('usage: node transcript-probe.mjs <baseUrl> <sessionId> <outDir>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

const results = {}
const failures = []
function check(name, condition, detail) {
  results[name] = { ok: Boolean(condition), detail }
  if (!condition) failures.push(`${name}: ${JSON.stringify(detail)}`)
}

async function probe(path, init) {
  const response = await fetch(`${baseUrl}/react-note-probe${path}`, init)
  const text = await response.text()
  if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${text}`)
  return JSON.parse(text)
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

/** One sidebar row pointing at the measured conversation. */
const ONE_AGENT = () => ({
  person: { id: 'person-probe', name: 'Probe Person' },
  agents: [{
    agent: 'agent-alpha', name: 'Alpha', hasConversation: true,
    sessionId, blank: false,
    lastActivityAt: null, running: false,
    presence: 'offline', completion: 0, enabled: true, disabled: false,
  }],
})

/**
 * Stable transcript description: the painted text of the conversation body,
 * plus the identity of every node-ish element, so any added row, divider or
 * timestamp changes the comparison.
 * Self-contained because it is serialized into the page.
 * @returns the transcript text and the ordered element signature.
 */
function transcriptSignature() {
  const body = document.querySelector('[data-conversation-scroll]')
  if (body === null) return { missing: true }
  const signature = [...body.querySelectorAll('*')].map((element) => {
    const testId = element.getAttribute('data-testid')
    const text = element.children.length === 0 ? (element.textContent ?? '').trim() : ''
    return `${element.tagName}${testId === null ? '' : `#${testId}`}:${text}`
  })
  return { text: body.innerText, testIds: [...body.querySelectorAll('[data-testid]')].map(e => e.getAttribute('data-testid')), signature }
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const page = await context.newPage()
const consoleErrors = []
page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))

try {
  await page.route('**/v1/browser/inbox', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ONE_AGENT()) })
  })
  await page.route('**/v1/browser/inbox/channels', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ channels: [] }) })
  })
  await page.route('**/v1/browser/inbox/brand.svg', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'image/svg+xml',
      body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>',
    })
  })
  await page.route('**/v1/browser/inbox/open', async (route) => {
    const { agent } = JSON.parse(route.request().postData() ?? '{}')
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agent, sessionId, created: false, blank: false, lastActivityAt: null }),
    })
  })

  await page.goto(baseUrl, { waitUntil: 'load' })
  const notice = page.getByRole('button', { name: 'Continue' })
  if (await notice.count() > 0) await notice.click()
  await page.getByTestId('ui-inbox-row-agent-alpha').waitFor({ timeout: 30_000 })
  await page.getByTestId('ui-inbox-row-agent-alpha').click()
  await page.waitForSelector('[data-conversation-scroll]', { timeout: 30_000 })
  await sleep(2500)

  const before = await page.evaluate(transcriptSignature)
  check('the transcript painted the measured conversation',
    before.missing !== true && before.text.includes('turn three'),
    { text: before.text?.slice(0, 400) })
  await page.screenshot({ path: `${outDir}/transcript-01-before.png` })

  // ── log-only note: must change nothing ────────────────────────────────────
  const logOnly = await probe('/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, mode: 'log-only', emoji: '🔥', targetSeq: 1 }),
  })
  await sleep(2500)
  const afterLogOnly = await page.evaluate(transcriptSignature)
  await page.screenshot({ path: `${outDir}/transcript-02-log-only-note.png` })
  check('a log-only note adds no visible transcript content',
    afterLogOnly.text === before.text
    && JSON.stringify(afterLogOnly.signature) === JSON.stringify(before.signature), {
      beforeLength: before.signature?.length,
      afterLength: afterLogOnly.signature?.length,
      textDiff: { before: before.text?.slice(-200), after: afterLogOnly.text?.slice(-200) },
      newTestIds: afterLogOnly.testIds?.filter(id => !before.testIds?.includes(id)),
    })
  check('the log-only note was written to the log', logOnly.type === 'reaction/note', logOnly)

  // ── user-message carrier: must leak, which is why it is not the carrier ───
  const userMessage = await probe('/append', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, mode: 'user-message', emoji: '💥', targetSeq: 3 }),
  })
  await sleep(2500)
  const afterUserMessage = await page.evaluate(transcriptSignature)
  await page.screenshot({ path: `${outDir}/transcript-03-user-message-carrier.png` })
  check('the user-message carrier DOES appear in the transcript',
    afterUserMessage.text !== before.text && afterUserMessage.text.includes('[reaction-note]'),
    {
      carrier: userMessage.type,
      addedText: afterUserMessage.text?.slice(before.text?.length ?? 0)?.slice(0, 300),
      newTestIds: afterUserMessage.testIds?.filter(id => !before.testIds?.includes(id)),
    })
  results.consoleErrors = consoleErrors
} finally {
  await browser.close()
}

console.log(JSON.stringify({ results, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
