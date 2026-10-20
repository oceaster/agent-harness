import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

it('boots the shipped frontend and opens Settings without retired inventory plugins', async () => {
  const scaffold = await launchWebScaffold({})
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ locale: 'en-US' })
    const errors: string[] = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(scaffold.baseUrl)
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.getByText('Failed to load plugins', { exact: true }).count()).toBe(0)
    const manifest = await page.evaluate(() => Reflect.get(window, '__DSH_BOOT__') as {
      entries: Array<{ id: string }>
    })
    const plugins = manifest.entries.map(entry => entry.id)
    expect(plugins).not.toContain('@deepseek-ai/dsh-client-ui-settings-plugin-inventory')
    expect(plugins).not.toContain('@deepseek-ai/dsh-client-ui-settings-plugins')
    expect(plugins).not.toContain('@deepseek-ai/dsh-client-ui-settings-learn')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.waitFor()
    expect(await dialog.getByText('Appearance', { exact: true }).count()).toBe(1)
    expect(await dialog.locator('nav').count()).toBe(0)
    expect(await dialog.getByText('Plugins', { exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
    await page.keyboard.press('Escape')
    await page.reload()
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.getByText('Failed to load plugins', { exact: true }).count()).toBe(0)
    expect(errors).toEqual([])
  } finally {
    await browser.close()
    await scaffold.close()
  }
}, 120_000)
