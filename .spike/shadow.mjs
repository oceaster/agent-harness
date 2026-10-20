/**
 * Spike probe (part 5): with ui-workspace COMPOSED and ui-inbox shadowing
 * `sidebar.workspaces` at priority -1, prove the hero chrome still works and
 * find out what picking a workspace from the chip does to the session set.
 *
 * Usage: node shadow.mjs <baseUrl> <outdir> <label>
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from '/root/worktrees/inbox-ui-spike/apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir, label = 'shadow'] = process.argv.slice(2)
await mkdir(outDir, { recursive: true })

async function rpc(method, payload = {}) {
  const rpcId = `probe-${Math.random().toString(16).slice(2)}`
  const response = await fetch(`${baseUrl}/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  return (await response.json()).result
}

const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const consoleErrors = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))

const steps = { label }
await page.goto(baseUrl, { waitUntil: 'load' })
const notice = page.getByRole('button', { name: 'Continue' })
if (await notice.count() > 0) await notice.click()
await page.waitForTimeout(2500)

// Seed two workspaces through the Host API (the same call ui-workspace's
// picker makes), one of which the inbox conversation will belong to.
steps.workspaceRoot = (await rpc('workspace.create', { path: '/root' })).value?.workspace?.workspaceId
steps.workspaceOther = (await rpc('workspace.create', { path: '/tmp' })).value?.workspace?.workspaceId
steps.sessionCreated = (await rpc('session.create', {
  sessionId: 'session-inbox-owen-delta', workspaceId: steps.workspaceRoot, agentPreset: 'delta',
})).value
steps.sessionsBeforePick = (await rpc('session.list', {})).value.items.map(item => item.sessionId)

// Reload so the browser sees the seeded workspaces.
await page.reload({ waitUntil: 'load' })
await page.waitForTimeout(2500)
steps.composer = {
  textareaEnabled: await page.locator('textarea').count() > 0
    && await page.locator('textarea').first().isEnabled().catch(() => false),
  placeholder: await page.locator('textarea').first().getAttribute('placeholder').catch(() => null),
  chipText: await page.locator('button[aria-haspopup="menu"]').first().innerText().catch(() => null),
}
steps.inboxPanel = await page.getByTestId('ui-inbox-panel').count()
steps.workspaceBrowser = await page.getByRole('button', { name: 'Search sessions' }).count()
await page.screenshot({ path: `${outDir}/${label}-hero.png` })

// Does the chip still own a picker now that ui-workspace is composed?
const chip = page.locator('button[aria-haspopup="menu"]').first()
await chip.click()
await page.waitForTimeout(1200)
steps.chipMenuItems = await page.getByRole('menuitem').allInnerTexts().catch(() => [])
steps.chipDialog = await page.getByRole('dialog').count()
steps.chipMenu = await page.getByRole('menu').count()
await page.screenshot({ path: `${outDir}/${label}-chip-open.png` })

// Pick the OTHER workspace from that menu and watch the session set.
const other = page.getByRole('menuitem').filter({ hasText: 'tmp' }).first()
if (await other.count() > 0) {
  await other.click()
  await page.waitForTimeout(3000)
  steps.sessionsAfterPick = (await rpc('session.list', {})).value.items.map(item => ({
    id: item.sessionId, cwd: item.cwd, blank: item.blank, agentPreset: item.agentPreset,
  }))
  steps.composerAfterPick = {
    placeholder: await page.locator('textarea').first().getAttribute('placeholder').catch(() => null),
    chipText: await page.locator('button[aria-haspopup="menu"]').first().innerText().catch(() => null),
  }
  await page.screenshot({ path: `${outDir}/${label}-after-pick.png` })
}
steps.consoleErrors = consoleErrors.slice(0, 10)
console.log(JSON.stringify(steps, null, 2))
await browser.close()
