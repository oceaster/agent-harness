/**
 * Spike probe: screenshot the sidebar browsing region of a live `dsh web`
 * fixture and report what occupies `sidebar.workspaces`.
 *
 * Usage: node shot.mjs <baseUrl> <outdir> [label]
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { chromium } from '/root/worktrees/inbox-ui-spike/apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir, label = 'shot'] = process.argv.slice(2)
await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const consoleErrors = []
page.on('console', (message) => {
  if (message.type() === 'error') consoleErrors.push(message.text())
})
page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))

await page.goto(baseUrl, { waitUntil: 'load' })

// Wait for either occupant of the browsing region to appear.
const inbox = page.getByTestId('ui-inbox-panel')
const workspaceBrowser = page.getByRole('button', { name: 'Search sessions' })
await Promise.race([
  inbox.waitFor({ timeout: 20_000 }).catch(() => {}),
  workspaceBrowser.waitFor({ timeout: 20_000 }).catch(() => {}),
])
// Let the connection settle and any late plugin apply land.
await page.waitForTimeout(2500)

const report = {
  label,
  url: baseUrl,
  inboxPanelPresent: await inbox.count() > 0,
  inboxRowCount: await page.locator('[data-testid^="ui-inbox-row-"]').count(),
  workspaceBrowserPresent: await workspaceBrowser.count() > 0,
  newSessionButtonPresent: await page.getByRole('button', { name: 'New Session' }).count() > 0,
  workspaceChip: {
    present: await page.getByRole('button', { name: 'Choose workspace' }).count() > 0,
    visible: await page.getByRole('button', { name: 'Choose workspace' }).isVisible().catch(() => false),
  },
  bootEntryIds: await page.evaluate(() => (globalThis.__DSH_BOOT__?.entries ?? []).map(entry => entry.id)),
  consoleErrors: consoleErrors.slice(0, 20),
}
await page.screenshot({ path: `${outDir}/${label}-full.png`, fullPage: false })
const region = page.getByTestId('ui-inbox-panel')
if (await region.count() > 0) await region.screenshot({ path: `${outDir}/${label}-inbox.png` })
await writeFile(`${outDir}/${label}.json`, JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
await browser.close()
