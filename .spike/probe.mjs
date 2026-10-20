/**
 * Spike probe (part 2): exercise the inbox panel in a live `dsh web` fixture.
 * Dismisses the first-run notice, screenshots the sidebar, drives the row
 * menu, and probes whether the empty-state workspace chip is a dead control
 * with ui-workspace disabled.
 *
 * Usage: node probe.mjs <baseUrl> <outdir> <label> [--chip-absent]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '/root/worktrees/inbox-ui-spike/apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir, label = 'probe'] = process.argv.slice(2)
await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))

await page.goto(baseUrl, { waitUntil: 'load' })
// First-run notice: dismiss it so the sidebar is not covered.
const notice = page.getByRole('button', { name: 'Continue' })
if (await notice.count() > 0) await notice.click()
await page.waitForTimeout(2500)

const steps = {}

// 1. Who occupies the browsing region?
steps.inboxPanel = await page.getByTestId('ui-inbox-panel').count()
steps.inboxMarkerText = await page.getByTestId('ui-inbox-marker').textContent().catch(() => null)
steps.workspaceBrowser = await page.getByRole('button', { name: 'Search sessions' }).count()
await page.screenshot({ path: `${outDir}/${label}-sidebar.png` })

// 2. The 3-dot menu opens and Clear fires.
await page.getByTestId('ui-inbox-menu-darwin').click()
steps.menuOpened = await page.getByTestId('ui-inbox-menu-body-darwin').isVisible().catch(() => false)
await page.screenshot({ path: `${outDir}/${label}-menu.png` })
await page.getByTestId('ui-inbox-clear-darwin').click()
steps.clearMarker = await page.evaluate(() => document.documentElement.dataset.inboxLastClear ?? null)
steps.menuClosedAfterClear = !(await page.getByTestId('ui-inbox-menu-body-darwin').isVisible().catch(() => false))

// 3. Row click → the runtime session-create path (prototype's open()).
await page.getByTestId('ui-inbox-open-diana').click()
steps.openMarker = await page.evaluate(() => document.documentElement.dataset.inboxLastOpen ?? null)
await page.waitForTimeout(3000)
steps.textareaAfterOpen = await page.locator('textarea').count()
steps.composerPlaceholder = await page.locator('textarea').first().getAttribute('placeholder').catch(() => null)
await page.screenshot({ path: `${outDir}/${label}-after-open.png` })

// 4. The empty-state workspace chip: is it a live control or a dead one?
const chip = page.getByRole('button', { name: 'Choose workspace' })
steps.chipPresent = await chip.count()
steps.chipVisible = await chip.isVisible().catch(() => false)
if (steps.chipVisible) {
  await chip.click()
  await page.waitForTimeout(1500)
  steps.chipDialogAfterClick = await page.getByRole('dialog').count()
  steps.chipMenuAfterClick = await page.getByRole('menu').count()
  await page.screenshot({ path: `${outDir}/${label}-chip-click.png` })
}

// 5. New Session button still works (it is ui-sidebar's, not ui-workspace's).
await page.keyboard.press('Escape')
const newSession = page.getByRole('button', { name: 'New Session' })
steps.newSessionPresent = await newSession.count()
if (await newSession.count() > 0) {
  await newSession.first().click()
  await page.waitForTimeout(2000)
  await page.screenshot({ path: `${outDir}/${label}-new-session.png` })
}

steps.consoleErrors = consoleErrors.slice(0, 20)
await writeFile(`${outDir}/${label}.json`, JSON.stringify(steps, null, 2))
console.log(JSON.stringify(steps, null, 2))
await browser.close()
