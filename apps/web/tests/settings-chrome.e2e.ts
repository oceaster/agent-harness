// Web e2e scenarios: the settings surface — the modal shell (trigger, the one
// rendered section, both close paths), the Appearance preference row (the
// real theme gesture — click 深色 and the whole cascade runs: ThemeRuntime preference -> Host settings
// -> theme/change -> ui-layout's presenter -> body attribute -> alias token +
// browser theme-color metadata)
// the busy-state Enter preference (both Host-backed), plus Permission as the
// persisted default for subsequently created sessions. The Language selector
// row is gone (FORK-NOTES: removed as broken and unsupported), so the language
// scenarios assert its absence and that the stored preference still governs.
// Zero model calls: everything is pure client + persistence state on a blank
// frame, so there is no fixture and a stray stream would fail loud on the
// open llm seam.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  acknowledgeReloadConnectionLoss, assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/settings-chrome', import.meta.url))
const DIALOG_EXPECTED = join(SNAPSHOT_DIR, 'dialog.expected.md')
// The English fallback surface: a browser naming no shipped language.
const DIALOG_EN_EXPECTED = join(SNAPSHOT_DIR, 'dialog-en.expected.md')
const MODE = webSnapshotMode()

describe('web e2e: settings modal and General preferences', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    // Chinese browser: the shared page asserts the localized settings surface
    // the client derives from it (the English default has its own spec below).
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('opens the settings dialog on its section and closes by every path', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-shell'))
    const trigger = page.getByRole('button', { name: '设置', exact: true })
    expect(await trigger.getAttribute('aria-haspopup')).toBe('dialog')
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    await trigger.click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    expect(await trigger.getAttribute('aria-expanded')).toBe('true')
    // No nav rail and no section switching: the panel is one content column and
    // the household's rows are there the moment the dialog opens.
    expect(await dialog.locator('nav').count()).toBe(0)
    expect(await dialog.getByRole('tab').count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '通用设置' }).count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '模型' }).count()).toBe(0)
    expect(await dialog.getByRole('button', { name: '插件', exact: true }).count()).toBe(0)
    // The rows that remain are there immediately: Appearance and the busy-Enter
    // behavior. (The Permission and Language rows this scenario used to anchor on
    // are gone — FORK-NOTES 12 and the Language-row removal — which predates the
    // nav removal.)
    await expect.poll(() => dialog.getByText('外观', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    // The configuration-file action is gone, not hidden: nothing in the dialog
    // asks the Host to open a document, and no request is made for one.
    let documentRequests = 0
    await page.route('**/api/settings.openDocument', async (route) => {
      documentRequests += 1
      await route.continue()
    })
    expect(await dialog.getByRole('button', { name: '打开配置文件' }).count()).toBe(0)
    // The top-right of the dialog holds the Close control and nothing else.
    const headerButtons = await dialog.evaluate((panel) => {
      const header = panel.firstElementChild
      return [...(header?.querySelectorAll('button') ?? [])].map(button => button.textContent?.trim())
    })
    expect(headerButtons).toEqual(['关闭'])
    // Golden of the freshly opened dialog (default zh, section rendered directly).
    const snapshot = await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(DIALOG_EXPECTED, snapshot, MODE)
    expect(documentRequests).toBe(0)
    await page.unroute('**/api/settings.openDocument')
    // Close path 1: Escape.
    await page.keyboard.press('Escape')
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(await trigger.getAttribute('aria-expanded')).toBe('false')
    // Close path 2: the header close button (focus lands there on open).
    await trigger.click()
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '关闭' }).click()
    await expect.poll(() => page.getByRole('dialog', { name: '设置' }).count(), { timeout: 5_000 }).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('stores Permission as the default for future sessions without changing an existing session', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-permission'))
    const existing = scaffold.ctx.sessions.create(SessionId('settings-permission-before'))
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const selector = dialog.getByRole('button', { name: 'Workspace Write' })
    await selector.waitFor({ timeout: 10_000 })
    await expect.poll(() => selector.isEnabled(), { timeout: 5_000 }).toBe(true)
    await selector.click()
    await page.getByRole('menuitem', { name: 'Read Only' }).click()
    await dialog.getByRole('button', { name: 'Read Only' }).waitFor({ timeout: 10_000 })

    const document = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(document).toContain('permission:')
    expect(document).toContain('defaultPreset: read-only')
    expect(existing.events.find(event => event.type === 'permission/preset')?.data)
      .toEqual({ preset: 'workspace-write' })

    const created = scaffold.ctx.sessions.create(SessionId('settings-permission-after'))
    expect(created.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'read-only' }],
      ['sandbox/mode', { mode: 'read-only' }],
      ['approval/policy', { policy: 'ask' }],
    ])

    await dialog.getByRole('button', { name: 'Read Only' }).click()
    await page.getByRole('menuitem', { name: 'Full access' }).click()
    const confirmation = page.getByRole('dialog', { name: '确认启用 Full access？' })
    const enable = confirmation.getByRole('button', { name: '启用 Full access' })
    expect(await enable.isDisabled()).toBe(true)
    await confirmation.getByRole('checkbox').click()
    await enable.click()
    await dialog.getByRole('button', { name: 'Full access' }).waitFor({ timeout: 10_000 })
    const confirmedDocument = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
    expect(confirmedDocument).toContain('defaultPreset: danger-full-access')
    const confirmed = scaffold.ctx.sessions.create(SessionId('settings-permission-confirmed'))
    expect(confirmed.events.map(event => [event.type, event.data])).toEqual([
      ['permission/preset', { preset: 'danger-full-access' }],
      ['sandbox/mode', { mode: 'danger-full-access' }],
      ['approval/policy', { policy: 'never' }],
    ])
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)

  it('uses the persisted dark preference while plugins are still loading', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-boot-theme'))
    await page.emulateMedia({ colorScheme: 'light' })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const initialDialog = page.getByRole('dialog', { name: '设置' })
    const darkCube = initialDialog.getByRole('button', { name: '深色' })
    await darkCube.click()
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await page.keyboard.press('Escape')

    // Hold real plugin bundles so the shell-owned loading page remains observable.
    const pluginPattern = /\/plugins\/@deepseek-ai\/dsh-client-ui-theme\/client\.js(?:\?.*)?$/
    let releaseBundles = (): void => {}
    const bundlesReleased = new Promise<void>((resolve) => { releaseBundles = resolve })
    await page.route(pluginPattern, async (route) => {
      await bundlesReleased
      await route.continue()
    })

    const warningStart = tripwire.warnings.length
    let reload: ReturnType<Page['reload']> | undefined
    try {
      reload = page.reload({ waitUntil: 'domcontentloaded' })
      // The branded placeholder is the only thing the shell paints before the
      // plugin roster activates, so it is the reload anchor: the kernel-owned
      // root still carries data-dsh-boot and the mark carries its own lane
      // attribute (the wordmark and 'Loading plugins…' line are gone).
      const bootMark = page.locator('[data-dsh-boot] [data-dsh-boot-mark]')
      await bootMark.waitFor({ timeout: 10_000 })
      const state = await bootMark.evaluate((mark) => {
        const boot = mark.closest<HTMLElement>('[data-dsh-boot]')
        if (boot === null) throw new Error('branded placeholder is detached from the boot page')
        return {
          attr: document.body.hasAttribute('data-ds-dark-theme'),
          background: getComputedStyle(boot).backgroundColor,
          colorScheme: document.documentElement.style.colorScheme,
        }
      })
      expect(state).toEqual({
        attr: true,
        // The fork's Aura dark fallback for the pre-plugin page is #0f0f0f
        // (upstream painted #151517; FORK-NOTES 3 records the recolor).
        background: 'rgb(15, 15, 15)',
        colorScheme: 'dark',
      })
    } finally {
      releaseBundles()
      await reload
      await page.unroute(pluginPattern)
    }

    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const restoredDialog = page.getByRole('dialog', { name: '设置' })
    const systemCube = restoredDialog.getByRole('button', { name: '跟随系统' })
    await systemCube.click()
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(() => page.evaluate(() => document.body.hasAttribute('data-ds-dark-theme')), {
      timeout: 5_000,
    }).toBe(false)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('flips the theme through the Appearance cubes and persists across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-appearance'))
    interface ThemeState {
      attr: boolean
      background: string
      /** Pre-migration localStorage key; the Host-backed world never writes it. */
      legacy: string | null
      themeColor: string | null
      themeColorCount: number
      token: string
    }
    const readState = async (target: Page = page): Promise<ThemeState> => await target.evaluate(() => {
      const metas = document.head.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      const computed = getComputedStyle(document.body)
      return {
        attr: document.body.hasAttribute('data-ds-dark-theme'),
        background: computed.backgroundColor,
        legacy: localStorage.getItem('dsh.theme'),
        themeColor: metas[0]?.content ?? null,
        themeColorCount: metas.length,
        token: computed.getPropertyValue('--dsw-alias-bg-base').trim(),
      }
    })
    const expectThemeColorSynchronized = (state: ThemeState): void => {
      expect(state.themeColorCount).toBe(1)
      expect(state.background).not.toBe('rgba(0, 0, 0, 0)')
      expect(state.themeColor).toBe(state.background)
    }
    // Pin the OS scheme to light so the default `system` preference resolves
    // light and the dark flip below is unambiguously the gesture's doing.
    await page.emulateMedia({ colorScheme: 'light' })
    const light = await readState()
    expect(light.attr).toBe(false)
    expectThemeColorSynchronized(light)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    const darkCube = dialog.getByRole('button', { name: '深色' })
    expect(await darkCube.getAttribute('aria-pressed')).toBe('false')
    await darkCube.click()
    // The full cascade: pressed state, Host-backed preference, body attribute,
    // alias token flip — all from one real user gesture.
    await expect.poll(() => darkCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    const dark = await readState()
    expect(dark.attr).toBe(true)
    expect(dark.legacy).toBeNull()
    expect(dark.token).not.toBe(light.token)
    expectThemeColorSynchronized(dark)
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-theme:\n\s+preference: dark/)
    await page.keyboard.press('Escape')

    // Reload: the preference survives the background Host read + presenter update.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.emulateMedia({ colorScheme: 'light' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    const reloaded = await readState()
    expect(reloaded.legacy).toBeNull()
    expectThemeColorSynchronized(reloaded)

    // A second live Host binds another ephemeral port but shares the same
    // user-settings home. Its fresh origin has no theme localStorage and still
    // converges to dark before the settings dialog opens.
    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.emulateMedia({ colorScheme: 'light' })
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await expect.poll(async () => (await readState(secondPage)).attr, { timeout: 5_000 }).toBe(true)
      const secondState = await readState(secondPage)
      expect(secondState.legacy).toBeNull()
      expectThemeColorSynchronized(secondState)
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    // `system` follows the emulated OS scheme (dark stays dark, light clears).
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const systemCube = page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '跟随系统' })
    await systemCube.click()
    await expect.poll(() => systemCube.getAttribute('aria-pressed'), { timeout: 5_000 }).toBe('true')
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expectThemeColorSynchronized(await readState())
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(true)
    expectThemeColorSynchronized(await readState())
    // Restore for the specs that follow: light preference beats the emulated
    // dark OS scheme, leaving the shared page in the light default.
    await page.getByRole('dialog', { name: '设置' }).getByRole('button', { name: '浅色' }).click()
    await expect.poll(async () => (await readState()).attr, { timeout: 5_000 }).toBe(false)
    expectThemeColorSynchronized(await readState())
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('persists the busy-state Enter behavior across reload and a distinct port', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-enter-behavior'))
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '排队发送' }).click()
    await page.getByRole('menuitem', { name: '插话发送' }).click()
    await dialog.getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-conversation:\n\s+busyEnter: steer/)
    await page.keyboard.press('Escape')

    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const reloaded = page.getByRole('dialog', { name: '设置' })
    await reloaded.getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })

    const second = await launchWebScaffold({ harnessHome: scaffold.harnessHome })
    const secondPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const secondTripwire = watchConsole(secondPage)
    try {
      expect(second.baseUrl).not.toBe(scaffold.baseUrl)
      await secondPage.goto(second.baseUrl, { waitUntil: 'load' })
      await secondPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await secondPage.getByRole('button', { name: '设置', exact: true }).click()
      await secondPage.getByRole('dialog', { name: '设置' })
        .getByRole('button', { name: '插话发送' }).waitFor({ timeout: 10_000 })
      expect(await secondPage.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
      expect(secondTripwire.pageErrors).toEqual([])
      expect(secondTripwire.warnings).toEqual([])
    } finally {
      await secondPage.close()
      await second.close()
    }

    await reloaded.getByRole('button', { name: '插话发送' }).click()
    await page.getByRole('menuitem', { name: '排队发送' }).click()
    await reloaded.getByRole('button', { name: '排队发送' }).waitFor({ timeout: 10_000 })
    expect(await page.evaluate(() => localStorage.getItem('dsh.conversation.busyEnter'))).toBeNull()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'), { timeout: 5_000 })
      .toMatch(/ui-conversation:\n\s+busyEnter: queue/)
    await page.keyboard.press('Escape')
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('offers no language selector and keeps a stored Host preference authoritative', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-settings-language'))
    // The General section carried a Language selector row; the owner removed it
    // as broken and unsupported (FORK-NOTES). What must survive the removal is
    // the machinery: the dialog copy resolves through the locale dictionaries
    // from the browser or the stored Host preference, and no row offers a
    // switch inside the surface.
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const zhDialog = page.getByRole('dialog', { name: '设置' })
    await zhDialog.waitFor({ timeout: 10_000 })
    // A zh browser: the assembled app still points the document tag at the
    // active locale, and the localised copy still resolves.
    expect(await page.evaluate(() => document.documentElement.lang)).toBe('zh-CN')
    expect(await zhDialog.getByText('语言', { exact: true }).count()).toBe(0)
    expect(await zhDialog.getByRole('button', { name: '中文' }).count()).toBe(0)
    expect(await zhDialog.getByRole('button', { name: 'English' }).count()).toBe(0)
    await expect.poll(() => zhDialog.getByText('外观', { exact: true }).count(), { timeout: 5_000 }).toBe(1)
    expect(await page.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
    await page.keyboard.press('Escape')

    // A stored Host preference still decides the surface for a browser that
    // asks for the other language, and still survives a reload — the half of
    // the old row's behavior that is not the selector itself.
    const seededHome = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-locale-'))
    await writeFile(join(seededHome, 'settings.yaml'), 'locale:\n  preference: en\n')
    const seeded = await launchWebScaffold({ harnessHome: seededHome })
    const seededPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    const seededTripwire = watchConsole(seededPage)
    try {
      await seededPage.goto(seeded.baseUrl, { waitUntil: 'load' })
      await seededPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await seededPage.getByRole('button', { name: 'Settings', exact: true }).click()
      const enDialog = seededPage.getByRole('dialog', { name: 'Settings' })
      await enDialog.waitFor({ timeout: 10_000 })
      await expect.poll(() => seededPage.evaluate(() => document.documentElement.lang), { timeout: 5_000 }).toBe('en')
      expect(await enDialog.getByText('Language', { exact: true }).count()).toBe(0)
      expect(await enDialog.getByText('Appearance', { exact: true }).count()).toBe(1)
      await seededPage.keyboard.press('Escape')

      const warningStart = seededTripwire.warnings.length
      await seededPage.reload({ waitUntil: 'load' })
      await seededPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      acknowledgeReloadConnectionLoss(seededTripwire, warningStart)
      await seededPage.getByRole('button', { name: 'Settings', exact: true }).waitFor({ timeout: 10_000 })
      expect(await seededPage.evaluate(() => document.documentElement.lang)).toBe('en')
      expect(seededTripwire.pageErrors).toEqual([])
      expect(seededTripwire.warnings).toEqual([])
    } finally {
      await seededPage.close()
      await seeded.close()
      await rm(seededHome, { recursive: true, force: true })
    }
    expect(tripwire.pageErrors).toEqual([])
  }, 90_000)

  it('opens an English browser in English without any stored preference', async () => {
    // A fresh Host home has no locale preference, so its surface follows the
    // browser. English is also FALLBACK_LOCALE, so this scenario alone cannot
    // distinguish detection from the default — the zh scenarios above supply
    // the discriminating half (a Chinese browser must NOT land on the default).
    const fresh = await launchWebScaffold({})
    const enPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'en-US' })
    const enTripwire = watchConsole(enPage)
    onTestFailed(() => saveFailureShot(enPage, 'web-e2e-settings-browser-language'))
    try {
      await enPage.goto(fresh.baseUrl, { waitUntil: 'load' })
      await enPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await enPage.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
      await enPage.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = enPage.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'General' }).waitFor({ timeout: 10_000 })
      expect(await dialog.getByText('Language', { exact: true }).count()).toBe(0)
      // This page has no closing inventory spec to sweep its console, so the
      // scenario clears both tripwire channels itself.
      expect(enTripwire.pageErrors).toEqual([])
      expect(enTripwire.warnings).toEqual([])
    } finally {
      await enPage.close()
      await fresh.close()
    }
  }, 90_000)

  it('opens a browser asking for no shipped language in English', async () => {
    // The product default for "no usable signal": a French browser ships
    // neither zh nor en, so resolution falls to FALLBACK_LOCALE (en) rather
    // than to Chinese.
    const fresh = await launchWebScaffold({})
    const frPage = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: 'fr-FR' })
    const frTripwire = watchConsole(frPage)
    onTestFailed(() => saveFailureShot(frPage, 'web-e2e-settings-unshipped-language'))
    try {
      await frPage.goto(fresh.baseUrl, { waitUntil: 'load' })
      await frPage.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await frPage.evaluate(() => localStorage.getItem('dsh.locale'))).toBeNull()
      await frPage.getByRole('button', { name: 'Settings', exact: true }).click()
      const dialog = frPage.getByRole('dialog', { name: 'Settings' })
      await dialog.waitFor({ timeout: 10_000 })
      await dialog.getByRole('button', { name: 'General' }).waitFor({ timeout: 10_000 })
      expect(await dialog.getByText('Language', { exact: true }).count()).toBe(0)
      // The markup already ships `en`, so this alone cannot prove the sync ran
      // — the zh scenario above is the discriminating half. Asserted here too
      // so a future change that resolves en but writes the wrong tag is caught.
      expect(await frPage.evaluate(() => document.documentElement.lang)).toBe('en')
      // Golden of the English fallback dialog — the visible output this change
      // produces. The zh golden above covers the detected-locale surface, so
      // the pair pins both directions of the resolution.
      const snapshot = await captureStableAria(frPage, '[role="dialog"]', fresh.workspaceCwd)
      await compareOrRefreshGolden(DIALOG_EN_EXPECTED, snapshot, MODE)
      expect(frTripwire.pageErrors).toEqual([])
      expect(frTripwire.warnings).toEqual([])
    } finally {
      await frPage.close()
      await fresh.close()
    }
  }, 90_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['dialog-en.expected.md', 'dialog.expected.md'])
  })
})
