/**
 * Spike probe (part 4): with one Host workspace registered, does the
 * conversation empty state unlock its composer when ui-workspace is disabled?
 * Usage: node composer.mjs <baseUrl> <outdir> <label>
 */
import { mkdir } from 'node:fs/promises'
import { chromium } from '/root/worktrees/inbox-ui-spike/apps/web/node_modules/playwright/index.mjs'

const [baseUrl, outDir, label = 'composer'] = process.argv.slice(2)
await mkdir(outDir, { recursive: true })
const browser = await chromium.launch({ executablePath: '/usr/bin/chromium', args: ['--no-sandbox'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: 'en-US' })
const consoleErrors = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', error => consoleErrors.push(`pageerror: ${String(error)}`))

await page.goto(baseUrl, { waitUntil: 'load' })
const notice = page.getByRole('button', { name: 'Continue' })
if (await notice.count() > 0) await notice.click()
await page.waitForTimeout(2500)

const steps = { label }
steps.workspaceChipText = await page.locator('button[aria-haspopup="menu"]').first().innerText().catch(() => null)
steps.textareaCount = await page.locator('textarea').count()
steps.textareaEnabled = await page.locator('textarea').first().isEnabled().catch(() => false)
steps.textareaPlaceholder = await page.locator('textarea').first().getAttribute('placeholder').catch(() => null)
steps.inboxPanel = await page.getByTestId('ui-inbox-panel').count()
steps.workspaceBrowser = await page.getByRole('button', { name: 'Search sessions' }).count()
steps.consoleErrors = consoleErrors.slice(0, 10)
await page.screenshot({ path: `${outDir}/${label}.png` })
console.log(JSON.stringify(steps, null, 2))
await browser.close()
