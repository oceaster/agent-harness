/**
 * Framework-free branded boot page and failure report. It remains available
 * when a client plugin fails because React arrives only with the UI renderer.
 * @module @deepseek-ai/dsh-client-web/src/boot-page
 */
import type { LoaderEntryState } from './loader-status.ts'
import css from './boot-page.module.css'

/** SVG namespace for the inline glow art: the page imports no framework. */
const SVG_NS = 'http://www.w3.org/2000/svg'

/** Serial keeps two boots in one document from sharing a filter id. */
let glowSerial = 0

/** Create a div with one module class and optional text. */
function div(className: string | undefined, text?: string): HTMLDivElement {
  const el = document.createElement('div')
  el.className = className ?? ''
  if (text !== undefined) el.textContent = text
  return el
}

/** Set the attributes of a namespace-created SVG node in one place. */
function svg<K extends keyof SVGElementTagNameMap>(
  name: K,
  values: Record<string, string>,
): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG_NS, name)
  for (const [attr, value] of Object.entries(values)) node.setAttribute(attr, value)
  return node
}

/**
 * The welcome screen's soft blue backdrop ellipse (figma 313:14109), inlined so
 * the page paints it with no fetch, no React and no theme delivery. Only the
 * blur survives from the original group: the `feFlood`/`feBlend` pair there
 * hid the backdrop behind the shape, and a standalone art element has nothing
 * to blend against.
 */
function glow(): SVGSVGElement {
  const filterId = `dsh-boot-glow-${String(glowSerial++)}`
  const root = svg('svg', {
    // `noUncheckedIndexedAccess` types a module class lookup as possibly
    // undefined; the stylesheet always declares it.
    class: css.glow ?? '',
    viewBox: '0 0 1051 468',
    fill: 'none',
    'aria-hidden': 'true',
  })
  const filter = svg('filter', {
    id: filterId,
    x: '0',
    y: '0',
    width: '1051',
    height: '468',
    filterUnits: 'userSpaceOnUse',
    colorInterpolationFilters: 'sRGB',
  })
  filter.append(svg('feGaussianBlur', { stdDeviation: '50' }))
  const defs = svg('defs', {})
  defs.append(filter)
  const group = svg('g', { filter: `url(#${filterId})` })
  group.append(svg('ellipse', {
    cx: '525.5',
    cy: '234',
    rx: '425.5',
    ry: '134',
    fill: '#6187D8',
    'fill-opacity': '0.08',
  }))
  root.append(defs, group)
  return root
}

/** Kernel-owned page mounted below the application's root element. */
export class BootPage {
  private readonly root: HTMLDivElement
  private readonly card: HTMLDivElement
  private readonly mark: HTMLDivElement
  private readonly states = new Map<string, LoaderEntryState>()
  private failure: string | undefined

  /**
   * Build and attach the boot page.
   * @param container - Application mount point.
   */
  constructor(container: HTMLElement) {
    this.root = div(css.boot)
    this.root.dataset.dshBoot = ''
    this.card = div(css.card)
    this.mark = div(css.mark)
    // The browser lane waits on this attribute: it is the whole loading screen
    // now that the wordmark, the spinner and the hint line are gone.
    this.mark.dataset.dshBootMark = ''
    this.mark.setAttribute('role', 'status')
    // No locale seat exists before the i18n plugin activates, so this label is
    // untranslated for the same reason the failure strings below it are.
    this.mark.setAttribute('aria-label', 'Loading')
    const logo = div(css.logo)
    logo.dataset.dshBootLogo = ''
    this.mark.append(glow(), logo)
    this.card.append(this.mark)
    this.root.append(this.card)
    container.append(this.root)
  }

  /**
   * Project one loader entry's fiber state.
   * @param id - Loader entry name.
   * @param state - Projected fiber state.
   */
  setState(id: string, state: LoaderEntryState): void {
    this.states.set(id, state)
    this.render()
  }

  /**
   * Display the boot failure report.
   * @param message - Failure report text.
   */
  fail(message: string): void {
    this.failure = message
    this.render()
  }

  /** Detach the page before or after the UI renderer takes the mount point. */
  dispose(): void {
    this.root.remove()
  }

  /** Redraw the state-dependent content below the mark. */
  private render(): void {
    const failed = [...this.states].filter(([, state]) => state === 'failed').map(([id]) => id)
    if (this.failure === undefined && failed.length === 0) {
      // Keep the mark node itself: only a report that just cleared is replaced.
      if (this.card.childElementCount !== 1 || this.card.firstElementChild !== this.mark) {
        this.card.replaceChildren(this.mark)
      }
      return
    }
    const report = div(css.failed)
    report.append(div(css.failedTitle, 'Failed to load plugins'))
    for (const id of failed) report.append(div(css.failedItem, id))
    if (this.failure !== undefined) report.append(div(css.failedItem, this.failure))
    this.card.replaceChildren(this.mark, report)
  }
}
