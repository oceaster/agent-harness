// @vitest-environment jsdom
/**
 * What the section shows: the empty line when no plugin contributed a view, a
 * lone view as a plain title rather than a one-button tab bar, and the real tab
 * chrome (with its keyboard contract) once a second view exists.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { PluginsSettingsSection } from '../src/client/PluginsSettingsSection.tsx'
import type { PluginsSettingsSectionProps, PluginsSettingsTabEntry } from '../src/client/PluginsSettingsSection.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

const t = (key: keyof typeof en) => en[key]

function renderSection(rows: readonly PluginsSettingsTabEntry[]) {
  const props = {
    t,
    useTabs: (selector: (value: readonly PluginsSettingsTabEntry[]) => unknown) => selector(rows),
    renderSlot: (_name: string, _owner: unknown, options: { only?: string }) => (
      <span>{options.only}</span>
    ),
  } as unknown as PluginsSettingsSectionProps
  render(<PluginsSettingsSection {...props} />)
}

describe('PluginsSettingsSection', () => {
  it('says so when no plugin contributed a view', () => {
    renderSection([])

    expect(screen.getByText(en.empty)).toBeTruthy()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('mounts its own heading and intro', () => {
    renderSection([{ id: 'all', order: 10, label: 'Plugin list' }])

    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })

  it('renders a lone view bare, with no tab bar and no repeat of its label', () => {
    // One page is not a choice: a tab bar holding a single button reads as a
    // control the reader is expected to press, and re-pitching that button as
    // a heading would duplicate the page's own title.
    renderSection([{ id: 'all', order: 10, label: 'Plugin list' }])

    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByRole('tab')).toBeNull()
    expect(screen.queryByRole('tabpanel')).toBeNull()
    expect(screen.queryByRole('heading', { name: 'Plugin list' })).toBeNull()
    expect(screen.getByText('all')).toBeTruthy()
    // The section still says what the page is for.
    expect(screen.getByRole('heading', { name: en.title })).toBeTruthy()
    expect(screen.getByText(en.intro)).toBeTruthy()
  })

  it('defaults to the first ordered tab and mounts another only after selection', () => {
    renderSection([
      { id: 'first', order: 0, label: 'First view' },
      { id: 'second', order: 10, label: 'Second view' },
    ])

    const first = screen.getByRole('tab', { name: 'First view' })
    const second = screen.getByRole('tab', { name: 'Second view' })
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('first')).toBeTruthy()
    expect(screen.queryByText('second')).toBeNull()

    fireEvent.click(second)
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('second')).toBeTruthy()
    expect(screen.getByText('first').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)

    fireEvent.click(first)
    expect(first.getAttribute('aria-selected')).toBe('true')
    expect(screen.getByText('second').closest('[role="tabpanel"]')).toHaveProperty('hidden', true)
  })

  it('moves focus and selection with standard horizontal tab keys', () => {
    renderSection([
      { id: 'first', order: 0, label: 'First view' },
      { id: 'second', order: 10, label: 'Second view' },
      { id: 'third', order: 20, label: 'Third view' },
    ])

    const first = screen.getByRole('tab', { name: 'First view' })
    const second = screen.getByRole('tab', { name: 'Second view' })
    const third = screen.getByRole('tab', { name: 'Third view' })
    expect(first.getAttribute('tabindex')).toBe('0')
    expect(second.getAttribute('tabindex')).toBe('-1')

    first.focus()
    fireEvent.keyDown(first, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(second)
    expect(second.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(second, { key: 'End' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'ArrowRight' })
    expect(document.activeElement).toBe(first)
    fireEvent.keyDown(first, { key: 'ArrowLeft' })
    expect(document.activeElement).toBe(third)
    fireEvent.keyDown(third, { key: 'Home' })
    expect(document.activeElement).toBe(first)

    fireEvent.keyDown(first, { key: 'Escape' })
    expect(document.activeElement).toBe(first)
    expect(first.getAttribute('aria-selected')).toBe('true')
  })
})
