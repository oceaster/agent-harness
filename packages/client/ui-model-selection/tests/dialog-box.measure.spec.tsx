// @vitest-environment jsdom
/**
 * Real-layout gate for the dialog's size.
 *
 * Owen, 2026-10-24: "Make the effort dialogue box 15% less wide and 10% less
 * tall (aprox made up numbers, not a real rule)." jsdom computes no layout, so
 * this spec renders the REAL component, transplants the REAL
 * `ModelSelect.module.css` (its CSS-module class names resolved to the hashed
 * ones the markup uses), and measures `getBoundingClientRect()` of the real
 * `[role="dialog"]` in headless Chromium at a fixed 1280x800 viewport with one
 * model offering four effort levels.
 *
 * Recorded at the change (2026-10-24), Chromium headless, default fonts:
 *   before — 296 x 119 px ('Thinking effort' heading present)
 *   after  — 252 x 102 px (heading gone)
 * The width assertion is exact because the card now declares
 * `box-sizing: border-box; width: 252px`; the height assertions are the
 * measured band, since the card's height is content-driven.
 *
 * The gate skips — loudly, never silently — where no Chromium exists; that is
 * every CI lane, so the run that matters is the one on the deployment host.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { ORDINARY_EFFORT_POLICY } from '../src/client/slots.ts'
import { en } from '../src/client/locales.ts'
import css from '../src/client/ModelSelect.module.css'

/** The measured before/after pair this gate defends (see the module comment). */
const BEFORE = { width: 296, height: 119 }
const AFTER_WIDTH = 252
/** Values within this many px of the record are the same card, not a reflow. */
const TOLERANCE = 1

const CHROMIUM = process.env.DSH_CHROMIUM ?? '/usr/bin/chromium'
const AVAILABLE = existsSync(CHROMIUM)

if (!AVAILABLE) {
  console.warn(`[ui-model-selection] dialog box measurement skipped: no Chromium at ${CHROMIUM} (set DSH_CHROMIUM)`)
}

const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }],
  defaultEffort: 'high',
}

const state: ModelDirectoryState = {
  current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  routable: true,
  groups: [{ id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }] }],
  failures: [],
  status: 'ready',
  error: null,
}

interface Measured {
  dialog: { width: number; height: number } | null
  heading: 'present' | null
}

/**
 * Lay out one markup fragment under the package's real stylesheet and measure it.
 * @param markup - the rendered seat markup (trigger + open dialog).
 * @returns the dialog's box and whether a heading element survived.
 */
function measureInChromium(markup: string): Measured {
  const source = readFileSync(join(process.cwd(), 'packages/client/ui-model-selection/src/client/ModelSelect.module.css'), 'utf8')
  // Every class selector in the file, resolved through the CSS-module map the
  // component itself imports: the page therefore uses the real declarations.
  const classes = css as unknown as Record<string, string>
  const stylesheet = source.replace(/\.([A-Za-z][\w-]*)/g, (_match, name: string) => `.${classes[name] ?? name}`)
  const headingClass = classes.effortHeading ?? 'effortHeading'
  const page = `<!doctype html><html><head><meta charset="utf-8"><style>${stylesheet}
    html,body{margin:0;padding:0}
    #host{position:relative;margin:400px auto 0;width:400px}</style></head>
    <body><div id="host">${markup}</div><pre id="out"></pre>
    <script>
      const dialog = document.querySelector('[role="dialog"]')
      const box = dialog === null ? null : dialog.getBoundingClientRect()
      document.getElementById('out').textContent = JSON.stringify({
        dialog: box === null ? null : { width: box.width, height: box.height },
        heading: document.querySelector('.${headingClass}') === null ? null : 'present',
      })
    </script></body></html>`
  const file = join(mkdtempSync(join(tmpdir(), 'effort-dialog-box-')), 'page.html')
  writeFileSync(file, page)
  const dom = execFileSync(CHROMIUM, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    '--window-size=1280,800', '--virtual-time-budget=2000', '--dump-dom', `file://${file}`,
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const found = /<pre id="out">([\s\S]*?)<\/pre>/.exec(dom)
  if (found === null) throw new Error('Chromium dumped no measurement node')
  return JSON.parse(found[1]
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')) as Measured
}

afterEach(cleanup)

describe.skipIf(!AVAILABLE)('effort dialog box, measured in a real browser', () => {
  it('is 15% narrower and at least 10% shorter than the heading-bearing card', () => {
    const directory = createSnapshotStore(state)
    const policy = createSnapshotStore(ORDINARY_EFFORT_POLICY)
    const view = render(<ModelSelect available locked={false} policy={policy} directory={directory}
      select={async () => true} load={() => {}} t={t} />)
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    expect(screen.getByRole('dialog')).toBeTruthy()
    const measured = measureInChromium(view.container.innerHTML)
    console.log(`[ui-model-selection] dialog box: ${String(measured.dialog?.width)}x${String(measured.dialog?.height)}`
      + ` (was ${String(BEFORE.width)}x${String(BEFORE.height)})`)
    expect(measured.dialog).not.toBeNull()
    const width = measured.dialog?.width ?? 0
    const height = measured.dialog?.height ?? 0
    // Width: the declaration, not an intention.
    expect(Math.abs(width - AFTER_WIDTH)).toBeLessThanOrEqual(TOLERANCE)
    expect(width).toBeLessThanOrEqual(BEFORE.width * 0.86)
    // Height: the removed heading is most of it; never a font-size trick, and
    // never a runaway shrink either.
    expect(height).toBeLessThanOrEqual(BEFORE.height * 0.90)
    expect(height).toBeGreaterThanOrEqual(96)
    // And the element Owen named is not in the laid-out page at all.
    expect(measured.heading).toBeNull()
  }, 60_000)
})
