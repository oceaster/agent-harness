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
import { SEEDED_SESSIONS } from './seeded-sessions.mjs'

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
    // Which sections the shell renders is the bundle's business, so the probe
    // reads them rather than naming one, and aims at the LAST nav row so the
    // active-section assertion cannot be satisfied by the first row by default.
    // A shell that renders no nav rail is reported, not failed: this probe is
    // about reload persistence, not about which sections a build ships.
    const sectionLabels = await page.evaluate(() => [...document.querySelectorAll('[role="dialog"] nav button')]
      .map(node => (node.textContent ?? '').trim()))
    record('settings section nav', { sections: sectionLabels }, null,
      sectionLabels.length === 0
        ? 'NO NAV ROWS — the shell renders its settings content without a nav rail in this build'
        : `${sectionLabels.length} sections`)
    const section = page.locator('[role="dialog"] nav button').last()
    if (sectionLabels.length > 0) await section.click()
    await page.waitForTimeout(500)
    const before = await snapshot('settings-open')
    await page.screenshot({ path: `${outDir}/06-settings-open.png` })
    await reload()
    const after = await snapshot('settings-after-reload')
    record('settings modal (open + active section)', { dialog: before.dom.dialog, keys: before.keys }, {
      dialog: after.dom.dialog,
      settingsKeys: Object.entries(after.keys).filter(([key]) => key.startsWith('dsh.settings')),
    },
    after.dom.dialog !== null && after.dom.dialog.activeNav.length > 0 ? 'PRESERVED' : 'LOST')

    // 7a. the CLOSED state must be remembered too: closing then reloading must
    // not surprise-reopen the panel, and reopening must return to the section
    // last seen rather than resetting to the first nav row.
    {
      // Reopen deliberately (whatever the reload left behind) so this step
      // starts from a known open panel on a non-first section, then locate the
      // close control INSIDE that dialog (the frame also has "Close details").
      if (await page.getByRole('dialog').count() === 0) await trigger.click()
      await page.getByRole('dialog').waitFor({ timeout: 10_000 })
      if (sectionLabels.length > 0) await section.click()
      await page.waitForTimeout(300)
      const closed = page.getByRole('dialog').getByRole('button', { name: 'Close' })
      check('the dialog exposes exactly one close control', await closed.count() === 1, `${await closed.count()} controls`)
      // The reading position has to be captured while the panel is still up:
      // the reopen assertion compares against it after the reload.
      const openOnSection = await snapshot('settings-open-before-close')
      await closed.click()
      await page.waitForTimeout(300)
      const closedBefore = await snapshot('settings-closed')
      await reload()
      const closedAfter = await snapshot('settings-closed-after-reload')
      record('settings modal (CLOSED state remembered)', {
        dialog: closedBefore.dom.dialog,
        settingsKeys: Object.entries(closedBefore.keys).filter(([key]) => key.startsWith('dsh.settings')),
      }, {
        dialogAfterReload: closedAfter.dom.dialog,
        settingsKeys: Object.entries(closedAfter.keys).filter(([key]) => key.startsWith('dsh.settings')),
      }, closedAfter.dom.dialog === null ? 'PRESERVED (stays closed)' : 'LOST (surprise-reopened)')
      check('a reload with the modal closed does not reopen it',
        closedAfter.dom.dialog === null, JSON.stringify(closedAfter.dom.dialog))

      // 7b. reopening after that reload lands on the section last seen.
      await trigger.click()
      await page.getByRole('dialog').waitFor({ timeout: 10_000 })
      await page.waitForTimeout(300)
      const reopened = await snapshot('settings-reopened')
      record('settings modal (reopen lands on the last section, not the first row)', {
        sectionBeforeClose: openOnSection.dom.dialog?.activeNav ?? null,
      }, { sectionAfterReopen: reopened.dom.dialog?.activeNav ?? null },
      JSON.stringify(reopened.dom.dialog?.activeNav) === JSON.stringify(openOnSection.dom.dialog?.activeNav)
        && (openOnSection.dom.dialog?.activeNav ?? []).length > 0
        ? 'PRESERVED' : 'LOST (reset to another section)')
      await page.screenshot({ path: `${outDir}/06b-settings-reopened.png` })

      const closeAgain = page.getByRole('button', { name: 'Close', exact: true })
      if (await closeAgain.count() === 1) await closeAgain.click()
      await page.waitForTimeout(200)
    }
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
// The disclosure family, one verdict per surface. The plan strip is measured in
// section 12 (seeded real host state); the rest are judged on whether this
// deployment can render the control at all, which is the test that decides
// whether persistence is owed to them.
record('tool-card disclosure (ui-tool ToolRow)', { rendered: 0 }, null,
  'REACHABLE in a conversation that holds a tool call; NOT PERSISTED — the expansion is `useState` in ui-tool/src/client/tool/components/ToolRow.tsx:149, a package outside this ticket\'s file scope. Flagged for the coordinator rather than silently dropped: it is the canonical case, and persisting it needs a ui-tool change (a session-scoped store read by ToolRow) following the same pattern as the plan strip.')
record('goal bar disclosure (ui-goal GoalBar)', { rendered: 0 }, null,
  'UNMEASURED and not persisted: renders only when the session holds a goal snapshot, and its local state is an edit form (`editing` / `draft` / `pending` at GoalBar.tsx:35-39), not a disclosure a reader would expect a reload to restore. A half-typed goal objective is not viewing state.')
record('jobs popover (ui-jobs JobListAction)', { rendered: 0 }, null,
  'UNMEASURED and not persisted: renders only when the session has a background job (JobListAction.tsx:118 returns null with no jobs), and its `open` flag is a transient popover — a reload reopening a job list the reader never asked for is a surprise, not a restoration.')
record('deliverables list (ui-deliverables ProducedFiles)', { rendered: 0 }, null,
  'UNMEASURED and not persisted: renders only when a turn produced files; its `shownCount` (ProducedFiles.tsx:79) is a Show-more cursor, not a preference — restoring a cursor into a list whose contents changed is arbitrary.')
record('plan mode control (ui-plan PlanModeControl)', { rendered: 0 }, null,
  'NOT PERSISTED: its local state is `leaving` (an in-flight transition) and `error` (a failure message) at PlanModeControl.tsx:21-22. Neither is a viewing position; persisting them would restore a stuck transition or a stale error banner.')

// ── 11. composer blocks ────────────────────────────────────────────────────
record('composer blocks (conversation input blockers)',
  { blocked: false }, null,
  'UNMEASURED / not user state: a block is transient derived state another plugin raises (ui-conversation/src/client/input/blocks.ts:68 createSnapshotStore with no persist), not a choice a person made. Measured observation: the composer was editable in every snapshot above, so no block was raised to re-observe.')

// ── 12. conversation disclosure: the plan strip, per conversation ──────────
// Measured in THIS context (same origin, same localStorage) against the two
// sessions seeded at fixture start (seed-disclosure-sessions.mjs). The host
// computes the `todos` projection from a real todo/write event in each log, so
// this is the shipped render path over real host state — not the `?fixture`
// wire client, whose composer is taken over by its resident pending question
// and whose only plan strip is the hidden chain-overlay fallback.
{
  /** Point the app at one conversation through its own persisted selection key. */
  const openSession = async (sessionId) => {
    await page.evaluate((id) => {
      localStorage.setItem('dsh.sessions.current', JSON.stringify({ sessionId: id }))
    }, sessionId)
    await page.reload({ waitUntil: 'load' })
    const notice = page.getByRole('button', { name: 'Continue' })
    if (await notice.count() > 0) await notice.click()
    await page.waitForTimeout(2000)
  }
  const stripState = async () => page.evaluate(() => {
    const panel = document.querySelector('[data-testid="todo-panel"]')
    if (panel === null) return { rendered: false }
    const header = panel.querySelector('button')
    const box = panel.getBoundingClientRect()
    const disclosure = Object.fromEntries(Object.entries(localStorage)
      .filter(([key]) => key.startsWith('dsh.conversation.disclosure')))
    return {
      rendered: true,
      visible: box.width > 0 && box.height > 0,
      expanded: header?.getAttribute('aria-expanded') ?? null,
      items: panel.querySelectorAll('li').length,
      summary: (panel.textContent ?? '').trim(),
      disclosure,
    }
  })

  await openSession(SEEDED_SESSIONS.alpha)
  const seeded = await stripState()
  check('the seeded conversation renders a live plan strip', seeded.rendered === true)
  check('the plan strip is visible, not a hidden overlay copy', seeded.visible === true)

  if (seeded.rendered === true && seeded.visible === true) {
    // 12a. the expansion itself.
    await page.locator('[data-testid="todo-panel"] button').click()
    await page.waitForTimeout(400)
    const expanded = await stripState()
    check('clicking the strip header expands it', expanded.expanded === 'true', expanded.expanded)
    await page.screenshot({ path: `${outDir}/09-todo-expanded.png` })
    await reload()
    await page.waitForTimeout(2000)
    const afterReload = await stripState()
    record('plan strip / todo dock disclosure (per conversation)', {
      expanded: expanded.expanded,
      items: expanded.items,
      disclosureKeys: expanded.disclosure,
    }, {
      expanded: afterReload.expanded,
      items: afterReload.items,
      disclosureKeys: afterReload.disclosure,
    }, afterReload.expanded === 'true'
      ? 'PRESERVED'
      : `LOST (expanded ${String(expanded.expanded)} -> ${String(afterReload.expanded)} after the reload)`)
    await page.screenshot({ path: `${outDir}/09b-todo-after-reload.png` })

    // 12b. scoping: conversation beta has its own plan and its own flag.
    await openSession(SEEDED_SESSIONS.beta)
    const beta = await stripState()
    check('the second seeded conversation renders its own plan strip', beta.rendered === true)
    record('plan strip disclosure scoping (two conversations)', {
      alphaExpanded: expanded.expanded,
      alphaDisclosureKeys: expanded.disclosure,
    }, {
      betaExpanded: beta.expanded,
      betaItems: beta.items,
      betaSummary: beta.summary,
      betaDisclosureKeys: beta.disclosure,
    }, beta.rendered !== true
      ? 'UNMEASURED: beta did not render a strip'
      : beta.expanded === 'false'
        ? 'PRESERVED (beta keeps its own collapsed state; alpha\'s expansion did not travel)'
        : 'LEAKED (beta inherited another conversation\'s expansion)')

    // 12c. the stale-key case: a stored value for a conversation that no longer
    // exists must not be read by the conversation that IS open.
    // Plant ONLY the orphan's key: alpha's own flag has to be absent, or the
    // measurement cannot tell the two apart (a value read from alpha's own key
    // is correct behaviour, not a leak).
    await page.evaluate((orphanId) => {
      for (let index = localStorage.length - 1; index >= 0; index -= 1) {
        const key = localStorage.key(index)
        if (key !== null && key.startsWith('dsh.conversation.disclosure')) localStorage.removeItem(key)
      }
      localStorage.setItem(`dsh.conversation.disclosure.${orphanId}`, JSON.stringify({ planCollapsed: false }))
    }, SEEDED_SESSIONS.orphan)
    await openSession(SEEDED_SESSIONS.alpha)
    const orphanEffect = await stripState()
    record('plan strip disclosure: stale key from a cleared conversation', {
      orphanKeyStored: JSON.stringify({ planCollapsed: false }),
      orphanSessionId: SEEDED_SESSIONS.orphan,
    }, {
      alphaExpanded: orphanEffect.expanded,
      alphaDisclosureKeys: orphanEffect.disclosure,
    }, orphanEffect.expanded === 'false'
      ? 'NO LEAK (only a cleared conversation\'s key was stored; the open conversation still started collapsed)'
      : 'LEAKED (a stale conversation value reached another conversation)')
  }

  // 12d. reasoning / context-injection / compaction row disclosures: the one
  // class of disclosure this ticket refuses for a structural reason.
  record('reasoning / context-injection / compaction row disclosure', { rendered: 0 }, null,
    'NOT PERSISTED, by structure rather than by scope: these rows mount by transcript INDEX (ReasoningRow in AssistantMarkdown.tsx:66 is `key={i}`), so a persisted expansion stored against an index re-expands whichever row later occupies that slot — the wrong row after a compaction or a truncated replay. They stay component-local until a row carries a stable identity. The plan strip covers the same reader need with an identity that is stable by construction (one strip per conversation).')
  record('queue dock disclosure (collapsed queue strip)', { rendered: false }, null,
    'NOT PERSISTED: the strip renders nothing while the queue is empty (QueueDock.tsx:47), and reaching a queued item needs a running turn plus a submitted prompt. It is also not at-rest state in this deployment: with an empty queue there is no control to persist for.')

  // 12e. effort: host-owned, so measure it where a model advertises levels.
  // A separate context keeps this origin\'s storage clean; `?fixture` swaps in
  // the shipped FixtureApiClient, whose catalog carries Off/High/Max.
  {
    const effortContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
    const effortPage = await effortContext.newPage()
    await effortPage.goto(`${baseUrl}/?fixture`, { waitUntil: 'load' })
    const notice = effortPage.getByRole('button', { name: 'Continue' })
    if (await notice.count() > 0) await notice.click()
    await effortPage.waitForTimeout(2500)
    const trigger = effortPage.locator('[data-testid="agent-effort-trigger"]')
    const triggerCount = await trigger.count()
    if (triggerCount === 0) {
      record('effort selection (reasoning effort)', { trigger: null }, null,
        'UNMEASURED: no effort trigger rendered in this composition')
    } else {
      const beforeLabel = await trigger.first().getAttribute('aria-label')
      await trigger.first().click()
      await effortPage.waitForTimeout(600)
      const slider = effortPage.locator('input[type="range"]')
      const levelCount = await slider.count()
      if (levelCount === 0) {
        record('effort selection (reasoning effort)', { beforeLabel, levels: 0 }, null,
          'UNMEASURED: the menu opened with no selectable level')
      } else {
        const selected = Number(await slider.inputValue())
        const max = Number(await slider.getAttribute('max'))
        const target = selected === max ? 0 : max
        await slider.fill(String(target))
        // The menu commits the slider position on Enter (ModelSelect's keyDown
        // calls choose(preview.id)); Escape would discard it.
        await effortPage.waitForTimeout(300)
        await slider.press('Enter')
        await effortPage.waitForTimeout(1200)
        await effortPage.waitForTimeout(300)
        const chosenLabel = await trigger.first().getAttribute('aria-label')
        const effortKeys = await effortPage.evaluate(() => Object.keys(localStorage).filter(key => /effort/i.test(key)))
        await effortPage.reload({ waitUntil: 'load' })
        await effortPage.waitForTimeout(2500)
        const reloadedLabel = await effortPage.locator('[data-testid="agent-effort-trigger"]').first().getAttribute('aria-label')
        record('effort selection (reasoning effort)', {
          beforeLabel, chosenLabel, levels: max + 1, clientKeysWritten: effortKeys,
        }, { reloadedLabel }, effortKeys.length === 0
          ? 'NOT CLIENT-OWNED, so not this ticket\'s to persist: the choice is submitted to the host '
            + '(select({ provider, model, reasoningEffort }) in ui-model-selection ModelSelect.tsx:57-60) and '
            + 'wrote no dsh.* key. It is a host-held per-session setting, not client state, so localStorage '
            + 'persistence would be a second mechanism beside the host\'s own. Limit: this measurement runs '
            + 'against the ?fixture in-memory host, which resets on reload, so the reloaded label here says '
            + 'nothing about host durability in the deployment.'
          : 'CLIENT-SIDE: a dsh.* key carries the effort, which would make it this ticket\'s to persist')
        notes.push(`effort: ${beforeLabel} -> ${chosenLabel} -> ${reloadedLabel} after reload (fixture host is in-memory; reload resets it)`)
      }
    }
    await effortPage.screenshot({ path: `${outDir}/10-effort.png` })
    await effortContext.close()
  }

  // Leave the app on the inbox conversation the earlier sections measured.
  await openSession(ALPHA_SESSION)
}


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
