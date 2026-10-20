// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { BootPage } from '../src/boot-page.ts'

afterEach(() => { document.body.innerHTML = '' })

function mount() {
  const el = document.createElement('div')
  document.body.append(el)
  return { el, page: new BootPage(el) }
}

describe('BootPage', () => {
  it('paints the household mark before any plugin state arrives', () => {
    const { el } = mount()
    expect(el.firstElementChild?.getAttribute('data-dsh-boot')).toBe('')
    const mark = el.querySelector('[data-dsh-boot-mark]')
    expect(mark).not.toBeNull()
    // The glow is the welcome screen's backdrop ellipse, inlined as svg art.
    const ellipse = mark?.querySelector('ellipse')
    expect(ellipse?.getAttribute('cx')).toBe('525.5')
    expect(ellipse?.getAttribute('ry')).toBe('134')
    expect(mark?.querySelector('[data-dsh-boot-logo]')).not.toBeNull()
    // The wordmark, the spinner, the progress arc and the hint line are gone;
    // the loading screen carries no text at all.
    expect(el.textContent).toBe('')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    expect(el.innerHTML).not.toContain('dsh-boot-arc')
  })

  it('stays a mark while entries activate or load', () => {
    const { el, page } = mount()
    page.setState('a', 'active')
    page.setState('b', 'loading')
    page.setState('c', 'pending')
    expect(el.querySelector('[data-dsh-boot-mark]')).not.toBeNull()
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    expect(el.innerHTML).not.toContain('dsh-boot-arc')
    expect(el.textContent).toBe('')
    expect(el.textContent).not.toContain('Failed to load plugins')
  })

  it('lists failed entries', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-layout', 'failed')
    page.setState('ok', 'active')
    page.setState('@deepseek-ai/dsh-client-ui-tool', 'failed')
    expect(el.textContent).toContain('Failed to load plugins')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-layout')
    expect(el.textContent).toContain('@deepseek-ai/dsh-client-ui-tool')
    expect(el.textContent).not.toContain('ok')
  })

  it('reports a failed entry with no spinner left to animate', () => {
    const { el, page } = mount()
    page.setState('@deepseek-ai/dsh-client-ui-theme', 'failed')
    const report = el.querySelector('[data-dsh-boot-mark]')?.nextElementSibling
    expect(report?.textContent).toContain('Failed to load plugins')
    expect(el.querySelector('[data-dsh-boot-spinner]')).toBeNull()
    expect(el.querySelectorAll('ellipse')).toHaveLength(1)
  })

  it('shows the complete sweep report', () => {
    const { el, page } = mount()
    const report = 'web boot: 1 entry did not activate\nx: pending (waiting for service: y)'
    page.fail(report)
    page.setState('a', 'active')
    expect(el.textContent).toContain('Failed to load plugins')
    expect(el.textContent).toContain(report)
  })

  it('keeps one stable mark node and drops a report that clears', () => {
    const { el, page } = mount()
    const mark = el.querySelector('[data-dsh-boot-mark]')
    page.setState('a', 'loading')
    page.setState('a', 'active')
    page.setState('b', 'failed')
    expect(el.textContent).toContain('Failed to load plugins')
    // A re-activated entry retracts its row; the loading face is the mark alone.
    page.setState('b', 'active')
    expect(el.textContent).toBe('')
    expect(el.querySelector('[data-dsh-boot-mark]')).toBe(mark)
  })

  it('detaches on disposal', () => {
    const { el, page } = mount()
    page.dispose()
    expect(el.childNodes).toHaveLength(0)
  })
})
