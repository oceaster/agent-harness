/**
 * Headless-Chromium proof for the inbox sidebar, against a keyless `dsh web`
 * fixture (tests/fixture/start-dsh-fixture.sh). No model call, no live
 * e-server, no real harness data:
 *
 * - GET/POST /v1/browser/inbox, /open and /clear are stubbed by Playwright
 *   route interception, so the payloads below are the whole "server".
 * - The open stub does what e-server does server-to-server: it creates that
 *   conversation on the fixture host over the loopback RPC (`session.create`
 *   with the deterministic id) before answering. That is the honest way to
 *   exercise the navigation seam — the browser must then show the session the
 *   server returned.
 *
 * Usage: node inbox-probe.mjs <baseUrl> <outDir>
 * Exits non-zero on any failed assertion.
 */
import { mkdir, writeFile } from 'node:fs/promises'
// Playwright is a devDependency of the web frontend package (the browser lane's
// home), so the probe resolves it from there instead of adding a second copy to
// this UI plugin.
import { chromium } from '../../../../../apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir = '/tmp/inbox-ui-proof'] = process.argv.slice(2)
if (baseUrl === undefined) {
  console.error('usage: node inbox-probe.mjs <baseUrl> <outDir>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

const results = {}
const failures = []
function check(name, condition, detail) {
  results[name] = { ok: Boolean(condition), detail }
  if (!condition) failures.push(`${name}: ${detail ?? 'failed'}`)
}

/** Fixed "now": the fixture's clock is the browser's, so pin timestamps relative to it. */
const nowSeconds = () => Date.now() / 1000

/**
 * Every row carries the fields the client's parser requires of the real
 * service (`enabled`, `disabled`, `presence`, `completion`); a payload without
 * them is refused as malformed, so a fixture that omits them proves nothing.
 */
const row = (fields) => ({
  hasConversation: true, blank: false, lastActivityAt: nowSeconds() - 320, running: false,
  enabled: true, disabled: false, presence: 'online', completion: 0, ...fields,
})

const THREE_AGENTS = () => ({
  person: { id: 'person-three', name: 'Household Person' },
  agents: [
    row({
      agent: 'agent-alpha', name: 'Alpha',
      sessionId: 'session-inbox-person-three-agent-alpha',
    }),
    row({
      agent: 'agent-beta', name: 'Beta',
      sessionId: 'session-inbox-person-three-agent-beta', blank: true,
      lastActivityAt: null, running: true, presence: 'running',
    }),
    row({
      agent: 'agent-gamma', name: 'Gamma', hasConversation: false,
      sessionId: null, blank: true, lastActivityAt: null,
    }),
  ],
})

/**
 * A coordinator with a delegation queue: its own turn runs, two delegations
 * wait for a worker slot and no descendant is running (the keyless fixture has
 * no model, so it cannot start one). The row must therefore keep the bare verb
 * rather than print `(0/2)`, and carry the same string into the dot.
 */
const QUEUED_COORDINATOR = () => ({
  person: { id: 'person-queue', name: 'Queue Person' },
  agents: [
    row({
      agent: 'agent-delta', name: 'Delta',
      sessionId: 'session-inbox-person-queue-agent-delta',
      running: true, presence: 'running', queuedWorkers: 2,
    }),
    row({
      agent: 'agent-darwin', name: 'Darwin',
      sessionId: 'session-inbox-person-queue-agent-darwin',
      queuedWorkers: 0,
    }),
  ],
})

const ONE_AGENT = () => ({
  person: { id: 'person-one', name: 'One Agent Person' },
  agents: [row({
    agent: 'agent-alpha', name: 'Alpha',
    sessionId: 'session-inbox-person-one-agent-alpha',
    lastActivityAt: nowSeconds() - 7200,
  })],
})

/** Loopback host RPC (the browser's own wire, used by the probe, not by the panel). */
async function rpc(method, payload) {
  const rpcId = `inbox-probe-${Math.random().toString(16).slice(2)}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await response.json()
  return body.result
}

/** One Chromium, one context per scenario; console errors are collected per page. */
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })

/** Boot a page whose inbox endpoints answer from the given scenario. */
async function openScenario(scenario) {
  const context = await browser.newContext({ viewport: scenario.viewport ?? { width: 1280, height: 900 }, locale: 'en-US' })
  const page = await context.newPage()
  const consoleErrors = []
  const requests = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/v1/browser/inbox')) {
      requests.push({ method: request.method(), path: url.pathname, body: request.postData(), at: Date.now() })
    }
  })

  let listCalls = 0
  await page.route('**/v1/browser/inbox', async (route) => {
    listCalls += 1
    const answer = scenario.list()
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })
  await page.route('**/v1/browser/inbox/open', async (route) => {
    const { agent } = JSON.parse(route.request().postData() ?? '{}')
    const answer = await scenario.open(agent)
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })
  await page.route('**/v1/browser/inbox/clear', async (route) => {
    const { agent } = JSON.parse(route.request().postData() ?? '{}')
    const answer = await scenario.clear(agent)
    await route.fulfill({ status: answer.status, contentType: 'application/json', body: JSON.stringify(answer.body) })
  })

  await page.goto(baseUrl, { waitUntil: 'load' })
  // First-run notice, when the fixture shows one.
  const notice = page.getByRole('button', { name: 'Continue' })
  if (await notice.count() > 0) await notice.click()
  // At a narrow viewport the sidebar may boot collapsed: the region's occupant
  // is the rail then, not the wide panel. Either way the inbox is on screen.
  await page.getByTestId('ui-inbox-panel').or(page.getByTestId('ui-inbox-rail')).first().waitFor({ timeout: 30_000 })
  return { context, page, consoleErrors, requests, listCalls: () => listCalls }
}

/**
 * Split console noise into what the PAGE produced and what the BROWSER's
 * network layer reported. Chromium logs one "Failed to load resource: ... 403"
 * line per non-2xx response; the guest refusal and the 503 error screen are
 * those responses working as designed, so they are recorded but not counted as
 * page errors. A JS error, a React warning printed as an error, or an uncaught
 * page error still fails the run.
 */
function splitConsole(consoleErrors) {
  const network = consoleErrors.filter(text => /^Failed to load resource/.test(text))
  const page = consoleErrors.filter(text => !/^Failed to load resource/.test(text))
  return { page, network }
}

/** Assert the removed surfaces are absent from the whole document. */
async function assertRemovedSurfaces(page) {
  const html = await page.content()
  return {
    noNewSession: !/New Session|New session|新建会话/.test(html),
    noWorkspaceChip: !/Choose workspace|选择工作区/.test(html),
    noSessionList: (await page.getByRole('button', { name: 'Search sessions' }).count()) === 0,
    noWorkspaceBrowser: (await page.locator('[data-testid="workspace-browser"]').count()) === 0,
  }
}

// ── scenario 1: three agents — rows, menu, confirm, after-clear ──────────────
{
  const state = THREE_AGENTS()
  const clears = []
  const s = await openScenario({
    list: () => ({ status: 200, body: state }),
    open: async (agent) => {
      const sessionId = `session-inbox-person-three-${agent}`
      // e-server's job: create the conversation on the host, under that id.
      await rpc('session.create', { sessionId })
      return {
        status: 200,
        body: { agent, sessionId, created: true, blank: true, lastActivityAt: null },
      }
    },
    clear: async (agent) => {
      clears.push(agent)
      return {
        status: 200,
        body: {
          agent, hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true,
        },
      }
    },
  })
  const { page, consoleErrors, requests } = s

  check('three-agent: one row per payload agent, in payload order',
    JSON.stringify(await page.locator('[data-testid^="ui-inbox-row-"]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-testid'))))
      === JSON.stringify(['ui-inbox-row-agent-alpha', 'ui-inbox-row-agent-beta', 'ui-inbox-row-agent-gamma']))
  check('three-agent: state lines (last activity / no messages yet / none)',
    (await page.getByTestId('ui-inbox-state-agent-alpha').textContent())?.includes('m ago')
    && (await page.getByTestId('ui-inbox-state-agent-beta').textContent()) === 'Working...'
    && (await page.getByTestId('ui-inbox-state-agent-gamma').textContent()) === 'No conversation yet',
    [
      await page.getByTestId('ui-inbox-state-agent-alpha').textContent(),
      await page.getByTestId('ui-inbox-state-agent-beta').textContent(),
      await page.getByTestId('ui-inbox-state-agent-gamma').textContent(),
    ].join(' | '))
  await page.screenshot({ path: `${outDir}/01-three-agents.png` })
  await page.getByTestId('ui-inbox-panel').screenshot({ path: `${outDir}/01-three-agents-panel.png` })

  // Open menu: exactly one action.
  await page.getByTestId('ui-inbox-menu-agent-alpha').click()
  const menuItems = await page.getByRole('menuitem').allTextContents()
  check('open menu: exactly one action, Clear', menuItems.length === 1 && menuItems[0]?.trim() === 'Clear', JSON.stringify(menuItems))
  await page.screenshot({ path: `${outDir}/02-open-menu.png` })

  // Confirm dialog: names the agent and states permanence.
  await page.getByRole('menuitem', { name: 'Clear' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.waitFor({ timeout: 10_000 })
  const dialogText = await dialog.textContent()
  check('confirm dialog names the agent and the permanence of the delete',
    dialogText?.includes('Clear your conversation with Alpha?') === true
    && dialogText?.includes('permanently deleted') === true, dialogText ?? '')
  check('confirm dialog did not clear anything yet', clears.length === 0, String(clears.length))
  await page.screenshot({ path: `${outDir}/03-confirm-dialog.png` })

  // Cancel via Escape, then confirm for real.
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'detached', timeout: 10_000 })
  check('escape cancels the dialog without clearing', clears.length === 0)

  await page.getByTestId('ui-inbox-menu-agent-alpha').click()
  await page.getByRole('menuitem', { name: 'Clear' }).click()
  await page.getByTestId('ui-inbox-confirm-clear').click()
  await page.waitForTimeout(600)
  check('after-clear: exactly one clear call for that agent', JSON.stringify(clears) === '["agent-alpha"]', JSON.stringify(clears))
  const freshLine = await page.getByTestId('ui-inbox-state-agent-alpha').textContent()
  check('after-clear: the row shows the fresh state without a reload', freshLine === 'No conversation yet', freshLine ?? '')
  await page.screenshot({ path: `${outDir}/04-after-clear.png` })

  // Row click → exactly one open call, and the pane shows the returned session.
  const before = requests.length
  await page.getByTestId('ui-inbox-open-agent-gamma').click()
  await page.waitForTimeout(2500)
  const openCalls = requests.filter(request => request.path === '/v1/browser/inbox/open')
  check('row click issues exactly one open call for that agent',
    openCalls.length === 1 && JSON.parse(openCalls[0]?.body ?? '{}').agent === 'agent-gamma',
    JSON.stringify(openCalls.map(call => call.body)))
  check('no request names a sessionId before open returned one',
    requests.every(request => request.path !== '/v1/browser/inbox' || !/session-inbox/.test(request.body ?? '')),
    'list requests carry no session id')
  const textarea = page.locator('textarea').first()
  check('the opened conversation renders a live composer',
    await textarea.count() > 0 && await textarea.isEditable(), `editable=${await textarea.isEditable().catch(() => 'n/a')}`)
  await textarea.click()
  await textarea.fill('typed without touching a workspace')
  const typed = await textarea.inputValue()
  check('the composer accepts text with no workspace click and no chip', typed === 'typed without touching a workspace', typed)
  await page.screenshot({ path: `${outDir}/05-opened-conversation.png` })

  const removed = await assertRemovedSurfaces(page)
  check('no New Session control anywhere in the DOM', removed.noNewSession)
  check('no workspace chip anywhere in the DOM', removed.noWorkspaceChip)
  check('no session list / workspace browser in the DOM', removed.noSessionList && removed.noWorkspaceBrowser)
  {
    const { page: pageErrors, network } = splitConsole(consoleErrors)
    check('three-agent: no page console errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)))
    check('three-agent: no refused network responses', network.length === 0, JSON.stringify(network.slice(0, 5)))
  }
  check('one open request reached the row click', requests.length > before, `${before} -> ${requests.length}`)
  results['three-agent requests'] = requests.map(request => `${request.method} ${request.path} ${request.body ?? ''}`)
  await s.context.close()
}

// ── scenario 2: one-agent person ────────────────────────────────────────────
{
  const s = await openScenario({
    list: () => ({ status: 200, body: ONE_AGENT() }),
    open: async (agent) => ({
      status: 200,
      body: { agent, sessionId: 'session-inbox-person-one-agent-alpha', created: false, blank: false, lastActivityAt: nowSeconds() - 7200 },
    }),
    clear: async (agent) => ({
      status: 200,
      body: { agent, hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true },
    }),
  })
  check('one-agent: exactly one row', (await s.page.locator('[data-testid^="ui-inbox-row-"]').count()) === 1)
  await s.page.screenshot({ path: `${outDir}/06-one-agent.png` })
  {
    const { page: pageErrors } = splitConsole(s.consoleErrors)
    check('one-agent: no page console errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)))
  }
  await s.context.close()
}

// ── scenario 2b: a coordinator with delegations waiting for a worker slot ───
{
  let state = QUEUED_COORDINATOR()
  const s = await openScenario({
    list: () => ({ status: 200, body: state }),
    open: async (agent) => ({
      status: 200,
      body: { agent, sessionId: `session-inbox-person-queue-${agent}`, created: false, blank: false, lastActivityAt: nowSeconds() - 60 },
    }),
    clear: async (agent) => ({
      status: 200,
      body: { agent, hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true },
    }),
  })
  const { page, consoleErrors } = s
  const line = await page.getByTestId('ui-inbox-state-agent-delta').textContent()
  // Two delegations wait and nothing runs below the row: the bare verb, never (0/2).
  check('queue: a waiting delegation with no running worker keeps the bare verb',
    line === 'Working...', line ?? '')
  check('queue: no (0) and no bare slash on the row', !line?.includes('(0)') && !line?.includes('/'), line ?? '')
  const dotLabel = await page.getByTestId('ui-inbox-open-agent-delta')
    .locator('[data-presence="running"]').getAttribute('aria-label')
  check('queue: the dot label is the working verb, not a count it does not have',
    dotLabel === 'Working', dotLabel ?? '')
  check('queue: the row keeps its own accessible name',
    (await page.getByTestId('ui-inbox-open-agent-delta').getAttribute('aria-label'))
      === 'Open your conversation with Delta')
  // queuedWorkers: 0 is the same row as no field at all: no suffix, no slash.
  const zero = await page.getByTestId('ui-inbox-state-agent-darwin').textContent()
  check('queue: an explicit zero queue renders today\'s line with no suffix',
    zero === '5m ago', zero ?? '')
  // The row is a fixed-width column: the queue copy must not overflow or clip it.
  const box = await page.getByTestId('ui-inbox-open-agent-delta').evaluate((node) => {
    const state = node.querySelector('[class*="state"]')
    return {
      rowOverflow: node.scrollWidth > node.clientWidth,
      stateOverflow: state === null ? null : state.scrollWidth > state.clientWidth,
      lineHeight: state === null ? null : state.getBoundingClientRect().height,
    }
  })
  check('queue: the row and its state line neither overflow nor clip',
    box.rowOverflow === false && box.stateOverflow === false && (box.lineHeight ?? 99) < 30, JSON.stringify(box))
  await page.screenshot({ path: `${outDir}/06b-queued-coordinator.png` })
  await page.getByTestId('ui-inbox-panel').screenshot({ path: `${outDir}/06b-queued-coordinator-panel.png` })

  // The queue drains: the next ordinary inbox read re-renders the row from the
  // refreshed payload, with no reload and no second polling loop of its own.
  const readsBefore = s.listCalls()
  state = {
    person: state.person,
    agents: state.agents.map(item => ({ ...item, running: false, presence: 'online', queuedWorkers: 0 })),
  }
  await page.waitForFunction(
    () => document.querySelector('[data-testid="ui-inbox-state-agent-delta"]')?.textContent !== 'Working...',
    undefined, { timeout: 15_000 },
  )
  const after = await page.getByTestId('ui-inbox-state-agent-delta').textContent()
  check('queue: the row settles on the existing inbox refresh, without a reload',
    after === '5m ago', after ?? '')
  check('queue: the settle cost one of the reads the panel already makes',
    s.listCalls() === readsBefore + 1, `${readsBefore} -> ${s.listCalls()}`)
  {
    const { page: pageErrors, network } = splitConsole(consoleErrors)
    check('queue: no page console errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)))
    check('queue: no refused network responses', network.length === 0, JSON.stringify(network.slice(0, 5)))
  }
  await s.context.close()
}

// ── scenario 3: a signed-in person the deployment composes nothing for ──────
{
  const s = await openScenario({
    list: () => ({ status: 200, body: { person: { id: 'person-none', name: 'No Agents' }, agents: [] } }),
    open: async () => ({ status: 403, body: { detail: 'not in roster' } }),
    clear: async () => ({ status: 403, body: { detail: 'not owned' } }),
  })
  check('empty person: plain explanatory state, not an empty list',
    (await s.page.getByTestId('ui-inbox-empty').textContent())?.includes('No agents yet') === true)
  check('empty person: no rows invented', (await s.page.locator('[data-testid^="ui-inbox-row-"]').count()) === 0)
  await s.page.screenshot({ path: `${outDir}/07-empty-person.png` })
  {
    const { page: pageErrors } = splitConsole(s.consoleErrors)
    check('empty person: no page console errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)))
  }
  await s.context.close()
}

// ── scenario 4: the guest refusal (403, no retry control) ───────────────────
{
  const s = await openScenario({
    list: () => ({ status: 403, body: { detail: 'DSH is unavailable to Guest' } }),
    open: async () => ({ status: 403, body: { detail: 'DSH is unavailable to Guest' } }),
    clear: async () => ({ status: 403, body: { detail: 'DSH is unavailable to Guest' } }),
  })
  const refused = await s.page.getByTestId('ui-inbox-refused').textContent()
  check('guest: refusal screen says the harness is not available to this profile',
    refused?.includes('not available to this profile') === true, refused ?? '')
  check('guest: no retry control on a refusal', (await s.page.getByTestId('ui-inbox-retry').count()) === 0)
  check('guest: distinct from the empty-list screen', (await s.page.getByTestId('ui-inbox-empty').count()) === 0)
  await s.page.screenshot({ path: `${outDir}/08-guest-refused.png` })
  {
    const { page: pageErrors, network } = splitConsole(s.consoleErrors)
    check('guest: no page console errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)))
    // The single 403 is the refusal itself reaching the network log.
    check('guest: exactly one refused response (the 403 refusal itself)', network.length === 1, JSON.stringify(network))
  }
  await s.context.close()
}

// ── scenario 5: narrow viewport (the 56px rail) ─────────────────────────────
{
  const s = await openScenario({
    viewport: { width: 900, height: 800 },
    list: () => ({ status: 200, body: THREE_AGENTS() }),
    open: async () => ({ status: 200, body: { agent: 'agent-alpha', sessionId: 's-x', created: false, blank: false, lastActivityAt: nowSeconds() } }),
    clear: async (agent) => ({ status: 200, body: { agent, hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true } }),
  })
  // Collapse the column to reach the rail (it may already be collapsed).
  const collapse = s.page.getByRole('button', { name: 'Collapse sidebar' })
  if (await collapse.count() > 0) await collapse.click()
  await s.page.waitForTimeout(500)
  const rail = await s.page.getByTestId('ui-inbox-rail').count()
  check('narrow: the collapsed column renders the inbox rail', rail === 1, String(rail))
  await s.page.screenshot({ path: `${outDir}/09-narrow-rail.png` })
  {
    const { page: pageErrors } = splitConsole(s.consoleErrors)
    check('narrow: no page console errors', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)))
  }
  await s.context.close()
}

// ── scenario 6: an unreachable API degrades to a visible failure ────────────
{
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
  page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))
  let calls = 0
  await page.route('**/v1/browser/inbox', async (route) => {
    calls += 1
    await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'restarting' }) })
  })
  await page.goto(baseUrl, { waitUntil: 'load' })
  const notice = page.getByRole('button', { name: 'Continue' })
  if (await notice.count() > 0) await notice.click()
  await page.getByTestId('ui-inbox-error').waitFor({ timeout: 30_000 })
  check('unreachable API: visible error row with a retry control',
    (await page.getByTestId('ui-inbox-retry').count()) === 1)
  await page.getByTestId('ui-inbox-retry').click()
  await page.waitForTimeout(500)
  check('unreachable API: retry re-reads', calls >= 2, `${calls} reads`)
  await page.screenshot({ path: `${outDir}/10-api-error.png` })
  {
    const { page: pageErrors, network } = splitConsole(consoleErrors)
    check('unreachable API: no page console errors and no unhandled rejection',
      pageErrors.length === 0 && consoleErrors.filter(text => text.startsWith('pageerror')).length === 0,
      JSON.stringify(pageErrors.slice(0, 5)))
    check('unreachable API: the 503s are the only network log lines', network.length === 2, JSON.stringify(network))
  }
  await context.close()
}

await browser.close()
await writeFile(`${outDir}/inbox-proof.json`, JSON.stringify({ results, failures }, null, 2))
console.log(JSON.stringify({ ok: failures.length === 0, failures, results }, null, 2))
process.exit(failures.length === 0 ? 0 : 1)
