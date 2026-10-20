/**
 * The boot page's art and dependency contract, asserted against the sources on
 * disk. The loading screen paints before any plugin exists, so the two things
 * that must never drift are invisible to a DOM test: the brand asset must be an
 * absolute path (theme delivery and plugin CSS are not available yet), and the
 * module must stay framework-free because React arrives with the UI renderer.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  fileURLToPath(new URL('../src/boot-page.module.css', import.meta.url)),
  'utf8',
)
const source = readFileSync(
  fileURLToPath(new URL('../src/boot-page.ts', import.meta.url)),
  'utf8',
)

describe('boot page art contract', () => {
  it('masks the household mark from the absolute inbox asset path', () => {
    // Absolute path on purpose: it resolves against the e-server origin inside
    // the DSH iframe as well as on the standalone page, and a deployment
    // without e-server answers 404 — the mask then paints nothing, so the mark
    // degrades to invisible while the background and the failure report still
    // render. Nothing here may become an import or a themed token.
    expect(stylesheet).toContain("mask: url('/v1/browser/inbox/brand.svg') center / contain no-repeat;")
    expect(stylesheet).toContain("-webkit-mask: url('/v1/browser/inbox/brand.svg') center / contain no-repeat;")
    expect(stylesheet).not.toMatch(/@import/)
    expect(stylesheet).not.toMatch(/url\(\s*['"]?(?:https?:)?\/\//)
  })

  it('leaves no spinner, wordmark or progress arc behind', () => {
    // The rotating arc and the elements it animated are gone, not hidden.
    expect(stylesheet).not.toMatch(/\.spinner|@keyframes|conic-gradient|--dsh-boot-arc/)
    expect(stylesheet).not.toMatch(/\.wordmark|\.hint\b/)
    expect(source).not.toMatch(/dsh-boot-spinner|dsh-boot-arc|HARNESS|Loading plugins|updateProgress/)
  })

  it('stays framework-free', () => {
    // React arrives only with the UI renderer: this module imports its own
    // sibling state vocabulary and its stylesheet, nothing else.
    const imports = source.split('\n').filter(line => line.startsWith('import '))
    expect(imports).toEqual([
      "import type { LoaderEntryState } from './loader-status.ts'",
      "import css from './boot-page.module.css'",
    ])
  })
})
