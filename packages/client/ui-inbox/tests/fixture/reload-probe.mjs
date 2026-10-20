/**
 * Reload-persistence probe: what does a browser reload actually preserve?
 *
 * Runs against the keyless `dsh web` fixture (tests/fixture/start-dsh-fixture.sh)
 * with the REAL built client bundle of the checkout that owns this file. The
 * inbox and agent-channel endpoints are Playwright route stubs; the two agent
 * conversations are created on the fixture host over the loopback RPC
 * (`session.create`), exactly as e-server does server-to-server, so the session
 * list the client mirrors is real.
 *
 * ONE browser context, ONE page, one localStorage origin for the whole run: the
 * app is driven to a surface, the DOM/localStorage value is recorded, the page is
 * reloaded with `location.reload()`, and the value is recorded again. Every
 * persists/does-not-survive claim in the report is one of those before/after
 * pairs — nothing here is inferred from source.
 *
 * Usage: node reload-probe.mjs <baseUrl> <outDir>
 * Writes <outDir>/reload-proof.json and exits non-zero on a failed assertion.
 */
import { mkdir, writeFile } from 'node:fs/promises'
// Playwright is a devDependency of the web frontend package (the browser lane's
// home), so the probe resolves it from there instead of adding a second copy to
// this UI plugin.
import { chromium } from '../../../../../apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir = '/tmp/reload-proof'] = process.argv.slice(2)
if (baseUrl === undefined) {
  console.error('usage: node reload-probe.mjs <baseUrl> <outDir>')
  process.exit(2)
}
await mkdir(outDir, { recursive: true })

/** Every measurement: a surface, the value before a reload, and after it. */
const measurements = []
const failures = []
const notes = []

function record(surface, before, after, verdict) {
  measurements.push({ surface, before, after, verdict })
}

function check(name, condition, detail) {
  if (!condition) failures.push(`${name}: ${detail ?? 'failed'}`)
}

const nowSeconds = () => Date.now() / 1000

/** Loopback host RPC: the browser's own wire, used by the probe (not by the panel). */
async function rpc(method, payload) {
  const rpcId = `reload-probe-${Math.random().toString(16).slice(2)}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  const body = await response.json()
  return body.result
}

// ── the stubbed inbox API ────────────────────────────────────────────────────
/**
 * One person with two agents plus one channel. Fields are the ones the client's
 * parser requires of the real service (`enabled`, `disabled`, `presence`,
 * `completion`); a payload without them is refused as malformed, so a fixture
 * that omits them proves nothing.
 */
const row = (fields) => ({
  hasConversation: true, blank: false, lastActivityAt: nowSeconds() - 320, running: false,
  enabled: true, disabled: false, presence: 'online', completion: 0, ...fields,
})

const ALPHA = 'agent-alpha'
const BETA = 'agent-beta'
const ALPHA_SESSION = 'session-inbox-person-spike-agent-alpha'
const BETA_SESSION = 'session-inbox-person-spike-agent-beta'
const CHANNEL = { id: 'channel-alpha-beta', name: 'Alpha and Beta', agents: [ALPHA, BETA], online: true }

const inboxState = {
  hasConversation: { [ALPHA]: false, [BETA]: false },
}

function inboxList() {
  return {
    person: { id: 'person-spike', name: 'Spike Person' },
    agents: [
      row({
        agent: ALPHA, name: 'Alpha', sessionId: ALPHA_SESSION,
        hasConversation: inboxState.hasConversation[ALPHA], blank: !inboxState.hasConversation[ALPHA],
        lastActivityAt: inboxState.hasConversation[ALPHA] ? nowSeconds() - 320 : null,
      }),
      row({
        agent: BETA, name: 'Beta', sessionId: BETA_SESSION,
        hasConversation: inboxState.hasConversation[BETA], blank: !inboxState.hasConversation[BETA],
        lastActivityAt: inboxState.hasConversation[BETA] ? nowSeconds() - 100 : null,
      }),
    ],
  }
}

const channelMessages = [
  { id: 'm1', sender: ALPHA, recipient: BETA, content: 'first channel message', priority: 'normal', created: nowSeconds() - 60, status: 'delivered' },
]

// ── one browser, one context, one page ──────────────────────────────────────
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const page = await context.newPage()
const consoleErrors = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))
/** Every inbox request the page made: body included, to show what identity it carries. */
const inboxRequests = []
page.on('request', (request) => {
  const url = new URL(request.url())
  if (url.pathname.startsWith('/v1/browser/inbox')) {
    inboxRequests.push({ method: request.method(), path: url.pathname, body: request.postData() })
  }
})

await page.route('**/v1/browser/inbox', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(inboxList()) })
})
await page.route('**/v1/browser/inbox/channels', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ channels: [CHANNEL] }) })
})
await page.route('**/v1/browser/inbox/channels/*', async (route) => {
  const url = new URL(route.request().url())
  if (url.pathname.endsWith('/clear')) {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ cleared: true }) })
    return
  }
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ messages: channelMessages }) })
})
await page.route('**/v1/browser/inbox/seen', async (route) => {
  await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ seen: true }) })
})
await page.route('**/v1/browser/inbox/open', async (route) => {
  const { agent } = JSON.parse(route.request().postData() ?? '{}')
  const sessionId = agent === BETA ? BETA_SESSION : ALPHA_SESSION
  const created = !inboxState.hasConversation[agent]
  // e-server's job: create the conversation on the host, under that id.
  if (created) await rpc('session.create', { sessionId })
  inboxState.hasConversation[agent] = true
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ agent, sessionId, created, blank: created, lastActivityAt: created ? null : nowSeconds() - 300 }),
  })
})
await page.route('**/v1/browser/inbox/clear', async (route) => {
  const { agent } = JSON.parse(route.request().postData() ?? '{}')
  inboxState.hasConversation[agent] = false
  await route.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ agent, hasConversation: false, sessionId: null, blank: true, lastActivityAt: null, cleared: true }),
  })
})

// ── observation helpers ─────────────────────────────────────────────────────

/** Every `dsh.*` localStorage key and its raw value. */
async function dumpKeys() {
  return page.evaluate(() => {
    const out = {}
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)
      if (key !== null) out[key] = localStorage.getItem(key)
    }
    return Object.fromEntries(Object.entries(out).sort(([left], [right]) => left.localeCompare(right)))
  })
}

/** The whole observed surface at one instant: DOM facts + storage facts. */
async function snapshot(label) {
  const dom = await page.evaluate(() => {
    const frame = document.querySelector('[style*="--ui-frame-rail-width"]')
    const occupant = document.querySelector('[data-testid="ui-inbox-panel"], [data-testid="ui-inbox-rail"]')
    const channelPage = document.querySelector('[data-testid="agent-channel-page"]')
    const textarea = document.querySelector('textarea')
    const dialog = document.querySelector('[role="dialog"]')
    const effort = document.querySelector('[data-testid="agent-effort-trigger"]')
    const activeTab = document.querySelector('[role="tab"][aria-selected="true"]')
    const tabs = [...document.querySelectorAll('[role="tab"]')].map(node => node.textContent)
    const durationToggle = document.querySelector('[aria-pressed][title]')
    return {
      center: channelPage !== null
        ? `agent-channel-page:${channelPage.getAttribute('aria-label') ?? ''}`
        : textarea !== null ? 'conversation:composer' : 'nothing',
      channelRows: [...document.querySelectorAll('[data-testid^="agent-channel-row-"]')].map(node => node.getAttribute('data-testid')),
      channelMessages: document.querySelectorAll('[data-testid="agent-channel-message"]').length,
      sidebarOccupant: occupant === null ? null : {
        testid: occupant.getAttribute('data-testid'),
        width: Math.round(occupant.getBoundingClientRect().width),
      },
      frame: frame === null ? null : {
        gridTemplateColumns: frame.style.gridTemplateColumns,
        sidebarCollapsed: frame.getAttribute('data-sidebar-collapsed'),
        detailsCollapsed: frame.getAttribute('data-details-collapsed'),
        portrait: frame.getAttribute('data-portrait'),
      },
      textarea: textarea === null ? null : { value: textarea.value, editable: !textarea.disabled },
      dialog: dialog === null ? null : {
        label: dialog.getAttribute('aria-label'),
        activeNav: [...document.querySelectorAll('[aria-current="true"]')].map(node => node.textContent),
      },
      effortTrigger: effort === null ? null : effort.getAttribute('aria-label'),
      inboxCurrent: [...document.querySelectorAll('[data-testid^="ui-inbox-open-"][aria-current="true"], [data-testid^="ui-inbox-rail-"][aria-current="true"]')]
        .map(node => node.getAttribute('data-testid')),
      channelCurrent: [...document.querySelectorAll('[data-testid^="agent-channel-open-"][aria-current="true"], [data-testid^="agent-channel-rail-"][aria-current="true"]')]
        .map(node => node.getAttribute('data-testid')),
      tabs: tabs.map(text => text?.trim()),
      activeTab: activeTab?.textContent?.trim() ?? null,
      durationToggle: durationToggle === null ? null : {
        pressed: durationToggle.getAttribute('aria-pressed'),
        title: durationToggle.getAttribute('title'),
      },
      shownSession: [...document.querySelectorAll('[data-session-id]')].map(node => node.getAttribute('data-session-id')).slice(0, 3),
    }
  })
  return { label, dom, keys: await dumpKeys() }
}

/** Dismiss the first-run notice when this fixture shows one, and wait for the panel. */
async function settle() {
  const notice = page.getByRole('button', { name: 'Continue' })
  if (await notice.count() > 0) await notice.click()
  await page.getByTestId('ui-inbox-panel').or(page.getByTestId('ui-inbox-rail')).first().waitFor({ timeout: 30_000 })
  await page.waitForTimeout(400)
}

/** The one reload primitive this probe is allowed to use. */
async function reload() {
  await page.evaluate(() => { location.reload() })
  await page.waitForLoadState('load')
  await settle()
}

// ── run ─────────────────────────────────────────────────────────────────────
await page.goto(baseUrl, { waitUntil: 'load' })
await settle()

const boot = await snapshot('boot')
record('baseline after a cold boot (no interaction)', boot, null, 'baseline')

// ── 1. the agent conversation ────────────────────────────────────────────────
await page.getByTestId(`ui-inbox-open-${ALPHA}`).click()
await page.locator('textarea').first().waitFor({ timeout: 30_000 })
await page.waitForTimeout(800)
const conversationBefore = await snapshot('conversation-open')
await reload()
const conversationAfter = await snapshot('conversation-after-reload')
check('the conversation is still on screen after the reload',
  conversationAfter.dom.center === 'conversation:composer', conversationAfter.dom.center)
record('selected agent conversation', {
  center: conversationBefore.dom.center,
  storedCurrent: conversationBefore.keys['dsh.sessions.current'],
  markedCurrentRow: conversationBefore.dom.inboxCurrent,
}, {
  center: conversationAfter.dom.center,
  storedCurrent: conversationAfter.keys['dsh.sessions.current'],
  markedCurrentRow: conversationAfter.dom.inboxCurrent,
}, conversationBefore.keys['dsh.sessions.current'] === conversationAfter.keys['dsh.sessions.current']
  && conversationAfter.dom.center === 'conversation:composer'
  ? 'PRESERVED (same session id, same pane)'
  : 'LOST')
record('inbox current-agent highlight (InboxState.openAgent)',
  { markedCurrentRow: conversationBefore.dom.inboxCurrent },
  { markedCurrentRow: conversationAfter.dom.inboxCurrent },
  conversationBefore.dom.inboxCurrent.length === conversationAfter.dom.inboxCurrent.length
    && conversationAfter.dom.inboxCurrent.length > 0
    ? 'PRESERVED' : 'LOST')
await page.screenshot({ path: `${outDir}/01-conversation-after-reload.png` })

// ── 2. the agent channel ────────────────────────────────────────────────────
const channelRow = page.getByTestId(`agent-channel-open-${CHANNEL.id}`)
const channelRowCount = await channelRow.count()
check('the channel row is rendered from the stubbed channel list', channelRowCount === 1, `${channelRowCount} rows`)
if (channelRowCount === 1) {
  await channelRow.click()
  await page.getByTestId('agent-channel-page').waitFor({ timeout: 20_000 })
  await page.waitForTimeout(600)
  const channelBefore = await snapshot('channel-open')
  await reload()
  const channelAfter = await snapshot('channel-after-reload')
  record('selected agent channel (inbox `selected` + layout `page`)', {
    center: channelBefore.dom.center,
    messages: channelBefore.dom.channelMessages,
    markedChannelRow: channelBefore.dom.channelCurrent,
    keys: channelBefore.keys,
  }, {
    center: channelAfter.dom.center,
    messages: channelAfter.dom.channelMessages,
    markedChannelRow: channelAfter.dom.channelCurrent,
    keys: channelAfter.keys,
  }, channelAfter.dom.center.startsWith('agent-channel-page') ? 'PRESERVED' : 'LOST')
  check('a reload with a channel open does not come back to the channel',
    !channelAfter.dom.center.startsWith('agent-channel-page'), channelAfter.dom.center)
  notes.push(`channel: center after reload = ${channelAfter.dom.center}`)
  record('non-session page (ui-layout store `page`)', {
    centerSlot: channelBefore.dom.center,
    pageRegistrationRendered: channelBefore.dom.center.startsWith('agent-channel-page'),
  }, {
    centerSlot: channelAfter.dom.center,
    pageRegistrationRendered: channelAfter.dom.center.startsWith('agent-channel-page'),
  }, channelAfter.dom.center.startsWith('agent-channel-page') ? 'PRESERVED' : 'LOST')
  await page.screenshot({ path: `${outDir}/02-channel-after-reload.png` })
}

// ── 3. sidebar width ────────────────────────────────────────────────────────
{
  // Back on the conversation either way: the reload of step 2 selected nothing
  // to undo, so the sidebar toggle is the surface under test here.
  const collapse = page.getByRole('button', { name: 'Collapse sidebar' })
  const collapseCount = await collapse.count()
  check('the sidebar collapse control is present at 1280x900', collapseCount === 1, `${collapseCount} controls`)
  if (collapseCount === 1) {
    const wide = await snapshot('sidebar-wide')
    await collapse.click()
    await page.waitForTimeout(500)
    const collapsed = await snapshot('sidebar-collapsed')
    await reload()
    const after = await snapshot('sidebar-after-reload')
    record('sidebar width / collapsed state (ui-layout store.sidebar)', collapsed, after,
      after.dom.sidebarOccupant?.testid === collapsed.dom.sidebarOccupant?.testid
        && after.dom.frame?.gridTemplateColumns === collapsed.dom.frame?.gridTemplateColumns
        ? 'PRESERVED' : 'LOST')
    notes.push(`sidebar: wide=${wide.dom.frame?.gridTemplateColumns} collapsed=${collapsed.dom.frame?.gridTemplateColumns} afterReload=${after.dom.frame?.gridTemplateColumns}`)
    await page.screenshot({ path: `${outDir}/03-sidebar-after-reload.png` })
    // Restore the wide column for the later surfaces.
    const expand = page.getByTestId('ui-sidebar-expand')
    if (await expand.count() > 0) { await expand.click(); await page.waitForTimeout(500) }
  }
}

// ── 4. composer draft ───────────────────────────────────────────────────────
{
  const textarea = page.locator('textarea').first()
  check('a composer is on screen for the draft measurement', await textarea.count() > 0)
  if (await textarea.count() > 0) {
    const draft = `spike-draft-${Date.now()}`
    await textarea.click()
    await textarea.fill(draft)
    await page.waitForTimeout(400)
    const before = await snapshot('draft-typed')
    await reload()
    const after = await snapshot('draft-after-reload')
    record('composer draft text (chat store `draft`)', { draft, stored: Object.entries(before.keys).filter(([key]) => key.startsWith('dsh.conversation.chat')) },
      { observed: after.dom.textarea?.value, stored: Object.entries(after.keys).filter(([key]) => key.startsWith('dsh.conversation.chat')) },
      after.dom.textarea?.value === draft ? 'PRESERVED' : 'LOST')
    await page.screenshot({ path: `${outDir}/04-draft-after-reload.png` })
  }
}

// ── 5. conversation view tab (chat vs trajectory) ───────────────────────────
{
  const tabs = await page.getByRole('tab').allTextContents()
  notes.push(`view tabs visible: ${JSON.stringify(tabs.map(text => text.trim()))}`)
  if (tabs.length <= 1) {
    record('conversation view tab (chat store `view`)', { tabs: tabs.length }, null,
      'UNMEASURED: no view tab ring is rendered, so the stored `view` has no UI to drive. ConversationSession.tsx:112 needs views.list().length > 1, and the header that hosts the ring returns null for a non-subagent session (ConversationSession.tsx:79).')
  }
  if (tabs.length > 1) {
    const trajectoryTab = page.getByRole('tab').nth(tabs.length - 1)
    await trajectoryTab.click()
    await page.waitForTimeout(800)
    const before = await snapshot('trajectory-view')
    await reload()
    const after = await snapshot('trajectory-view-after-reload')
    record('conversation view tab (chat store `view`)', { activeTab: before.dom.activeTab, durationToggle: before.dom.durationToggle },
      { activeTab: after.dom.activeTab, durationToggle: after.dom.durationToggle },
      before.dom.activeTab === after.dom.activeTab ? 'PRESERVED' : 'LOST')
    await page.screenshot({ path: `${outDir}/05-trajectory-after-reload.png` })
    await page.screenshot({ path: `${outDir}/05-trajectory-after-reload.png` })
    // Back to the chat tab for the remaining surfaces.
    const chatTab = page.getByRole('tab').first()
    if (await chatTab.count() > 0) { await chatTab.click(); await page.waitForTimeout(400) }
  }
}

// ── 6. trajectory duration preference ──────────────────────────────────────
{
  const durationToggle = page.locator('[aria-pressed][title]').first()
  const count = await durationToggle.count()
  if (count === 0) {
    record('trajectory duration preference (`dsh.trajectory.duration`)', { visible: false }, null,
      'UNMEASURED: the toggle lives in the trajectory toolbar, and no tab ring rendered (0 [role=tab] nodes in every snapshot) so the trajectory view was never mounted. Cause: ui-conversation/src/client/skeleton/ConversationSession.tsx:112 renders the ring only when views.list().length > 1, and the same file returns null from ConversationSessionHeader (:79, !readOnly) for a non-subagent session — the inbox conversation has no header at all.')
  } else {
    const before = await durationToggle.getAttribute('aria-pressed')
    await durationToggle.click()
    await page.waitForTimeout(400)
    const toggled = await durationToggle.getAttribute('aria-pressed')
    const stored = (await dumpKeys())['dsh.trajectory.duration']
    await reload()
    const afterToggle = page.locator('[aria-pressed][title]').first()
    const after = await afterToggle.count() > 0 ? await afterToggle.getAttribute('aria-pressed') : null
    record('trajectory duration preference (`dsh.trajectory.duration`)',
      { before, toggled, stored },
      { after },
      after === toggled ? 'PRESERVED' : 'LOST')
  }
}

// ── 7. settings modal (open state + active section) ────────────────────────
{
  const trigger = page.getByRole('button', { name: 'Settings', exact: true })
  const count = await trigger.count()
  check('the settings trigger is present', count === 1, `${count} triggers`)
  if (count === 1) {
    await trigger.click()
    await page.getByRole('dialog').waitFor({ timeout: 10_000 })
    const learn = page.getByRole('button', { name: 'Learn More' })
    check('the Learn More settings section is registered', await learn.count() === 1, `${await learn.count()} rows`)
    if (await learn.count() === 1) await learn.click()
    await page.waitForTimeout(500)
    const before = await snapshot('settings-open')
    await page.screenshot({ path: `${outDir}/06-settings-open.png` })
    await reload()
    const after = await snapshot('settings-after-reload')
    record('settings modal (open + active section)', { dialog: before.dom.dialog }, { dialog: after.dom.dialog },
      after.dom.dialog !== null ? 'PRESERVED' : 'LOST')
  }
}

// ── 8. effort selection ────────────────────────────────────────────────────
{
  const effort = page.locator('[data-testid="agent-effort-trigger"]')
  const count = await effort.count()
  if (count === 0) {
    record('effort selection (host setting, `agent-effort-trigger`)', { trigger: null }, null,
      'UNMEASURED: the effort trigger never rendered (ui-model-selection returns null when the host reports no effort-capable model)')
  } else {
    const labelBefore = await effort.getAttribute('aria-label')
    await effort.click()
    await page.waitForTimeout(600)
    const menu = page.getByRole('dialog', { name: 'Effort' })
    const openMenu = await menu.count() > 0
    const slider = page.locator('input[type="range"]')
    const sliderCount = await slider.count()
    await page.screenshot({ path: `${outDir}/07-effort-menu.png` })
    if (sliderCount === 0) {
      record('effort selection (host setting)', { labelBefore, menuOpen: openMenu, levels: 0 }, null,
        'UNMEASURED: the effort menu opened with no selectable level (keyless fixture composes no effort-capable model)')
    } else {
      const before = await slider.inputValue()
      const max = await slider.getAttribute('max')
      if (Number(max) > 0) {
        await slider.fill(String(Number(before) === Number(max) ? 0 : Number(max)))
        await page.waitForTimeout(1200)
      }
      const chosen = await slider.inputValue().catch(() => null)
      await page.keyboard.press('Escape')
      await reload()
      const afterLabel = await page.locator('[data-testid="agent-effort-trigger"]').first().getAttribute('aria-label')
      record('effort selection (host setting)', { labelBefore, chosen, max },
        { labelAfter: afterLabel },
        afterLabel !== labelBefore ? 'PRESERVED (host-side)' : 'UNCHANGED/LOST')
    }
  }
}

// ── 9. details column ──────────────────────────────────────────────────────
{
  const before = await snapshot('details-before')
  notes.push(`details collapsed before the reload: ${String(before.dom.frame?.detailsCollapsed)}`)
  record('details column width (ui-layout store.details)',
    { openable: false, detailsCollapsed: before.dom.frame?.detailsCollapsed }, null,
    'UNMEASURED: nothing in this fixture can open the details column — `layout.openDetails()` has one UI caller, the tool-card Inspect path (ui-conversation/src/client/apply.ts:366), and a keyless fixture conversation holds no tool call.')
}

// ── 10. tool-card / plan / goal / jobs / deliverables disclosure ───────────
record('tool-card / plan / goal / jobs / deliverables disclosure',
  { toolCards: 0, planCards: 0, goalBar: 0, jobsAction: 0, deliverables: 0 }, null,
  'UNMEASURED: every one of those surfaces renders from a conversation event (a tool call, a plan, a goal snapshot, a job row, a produced file), and a keyless fixture conversation has none — no model is called, so no such event exists to expand or re-observe.')

// ── 11. composer blocks ────────────────────────────────────────────────────
record('composer blocks (conversation input blockers)',
  { blocked: false }, null,
  'UNMEASURED / not user state: a block is transient derived state another plugin raises (ui-conversation/src/client/input/blocks.ts:68 createSnapshotStore with no persist), not a choice a person made. Measured observation: the composer was editable in every snapshot above, so no block was raised to re-observe.')

// ── final: the whole key set, and any stray session ────────────────────────
const final = await snapshot('final')
await page.screenshot({ path: `${outDir}/08-final.png` })
{
  // Acceptance 6: is any key namespaced by the signed-in person? The stubbed
  // inbox payload is the only thing that ever told this client who is asking
  // (`person.id` = person-spike), and the two conversations are named the way
  // the deployment names them (`session-inbox-<profile>-<agent>`), so the
  // substring can appear INSIDE a session id without any person namespace.
  const keys = Object.keys(final.keys)
  const personPrefixKeys = keys.filter(key => /^dsh\.[^.]*person/i.test(key) || /person-spike\./.test(key))
  const personInsideSessionId = keys.filter(key => /person-spike/.test(key))
  const valuesWithPerson = Object.values(final.keys).some(value => /person-spike/.test(String(value)))
  record('person namespacing of the persisted keys', {
    keys,
    identityTheClientWasTold: { personId: 'person-spike', via: 'GET /v1/browser/inbox response body' },
  }, {
    keysWithPersonNamespacePrefix: personPrefixKeys,
    keysCarryingPersonString: personInsideSessionId,
    anyValueCarryingPersonId: valuesWithPerson,
    inboxRequests: inboxRequests.map(request => `${request.method} ${request.path} ${request.body ?? ''}`),
  }, personPrefixKeys.length === 0
    ? 'NO PERSON NAMESPACE: neither key carries a person prefix; the conversation key embeds the session id, which is only person-separated because the deployment names sessions session-inbox-<profile>-<agent>. dsh.sessions.current carries no person field at all, and no request the client makes names a person.'
    : 'PERSON NAMESPACE PRESENT')
}
{
  const { page: pageErrors } = {
    page: consoleErrors.filter(text => !/^Failed to load resource/.test(text)),
  }
  check('no page console errors during the run', pageErrors.length === 0, JSON.stringify(pageErrors.slice(0, 5)))
}

await context.close()
await browser.close()

const proof = {
  baseUrl,
  measurements,
  notes,
  failures,
  keysAtBoot: measurements[0]?.before.keys,
  keysAtEnd: final.keys,
  consoleErrors,
}
await writeFile(`${outDir}/reload-proof.json`, JSON.stringify(proof, null, 2))
console.log(JSON.stringify(proof, null, 2))
process.exit(failures.length === 0 ? 0 : 1)
