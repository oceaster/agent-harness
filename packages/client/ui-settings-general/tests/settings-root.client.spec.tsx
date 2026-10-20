// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useEffect, useState } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsRootComponentProps } from '../src/client/shell-contract.ts'
import { SettingsRoot } from '../src/client/SettingsRoot.tsx'
import { createSettingsShellStore } from '../src/client/settings-shell-store.ts'

// The shell's viewing state persists (dsh.settings.shell), so cases must not
// inherit each other's stored panel: clear storage with the unmount.
afterEach(() => {
  cleanup()
  localStorage.clear()
})

type Step = { id: string; order: number }

/** Slot-content stand-ins: the shell renders whatever the seats contribute. */
const SEAT_CONTENT: Record<string, string> = {
  'settings.trigger': 'Settings',
  'settings.header': 'Settings Title',
  'settings.close': 'Close',
}

function mount({
  wide = true,
  onboardingActive = true,
  sectionIds = ['general', 'models', 'agent-presets'],
  steps = [
    { id: 'welcome', order: -100 },
    { id: 'credential', order: 0 },
  ] as Step[],
  seed,
}: {
  wide?: boolean
  onboardingActive?: boolean
  sectionIds?: string[]
  steps?: Step[]
  /**
   * Pre-render store writes: the reload case (a rehydrated store before mount).
   * Bound actions, exactly what the component receives.
   */
  seed?: (actions: SettingsRootComponentProps['actions']) => void
} = {}) {
  // Mutable id list standing in for the bound useSectionIds hook; bump() plays a
  // ledger change through the same observable contract.
  let current = sectionIds
  const listeners = new Set<() => void>()
  const renderSlot = vi.fn(
    ((key: string, _owner: unknown, opts?: { only?: string }) => {
      if (key === 'settings.section') return <div data-testid={`section-${opts?.only ?? 'all'}`} />
      return SEAT_CONTENT[key]
    }) as SettingsRootComponentProps['renderSlot'],
  )
  const useSessions = ((select: (state: unknown) => unknown) => select(onboardingActive
    ? { phase: 'ready', current: undefined, byId: {} }
    : {
      phase: 'ready',
      current: 'active-session',
      byId: { 'active-session': { blank: false } },
    })) as never
  const unusedHook = (() => { throw new Error('unused by SettingsRoot') }) as never
  // The shell's viewing state lives in its registration store, so the harness
  // supplies a real instance (same factory the registration declares).
  const shell = createSettingsShellStore().create()
  seed?.(shell.actions)
  const props: SettingsRootComponentProps = {
    useStore: bindSnapshotSelector(shell),
    actions: shell.actions,
    useSessions,
    useWorkspaces: unusedHook,
    wide,
    useOnboardingSteps: select => select(steps),
    useSectionIds: (select) => {
      const [, force] = useState(0)
      useEffect(() => {
        const listener = () => { force(n => n + 1) }
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      }, [])
      return select(current)
    },
    renderSlot,
  }
  const view = render(<SettingsRoot {...props} />)
  const bump = (next: string[]) => {
    act(() => {
      current = next
      for (const fn of [...listeners]) fn()
    })
  }
  return { view, renderSlot, bump, listeners, shell }
}

function openPanel() {
  fireEvent.click(screen.getByRole('button', { name: 'Settings' }))
}

describe('SettingsRoot trigger', () => {
  it('renders the trigger seat content as the accessible name (no aria-label of its own)', () => {
    const { renderSlot } = mount()
    const trigger = screen.getByRole('button', { name: 'Settings' })
    expect(trigger.hasAttribute('aria-label')).toBe(false)
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: true })
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(trigger)
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Settings', expanded: true })).toBeTruthy()
  })

  it('hands the rail state to the trigger seat', () => {
    const { renderSlot } = mount({ wide: false })
    expect(renderSlot).toHaveBeenCalledWith('settings.trigger', { wide: false })
  })
})

describe('SettingsPanel chrome seats', () => {
  it('names the dialog via aria-labelledby pointing at the header seat node', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const titleId = dialog.getAttribute('aria-labelledby')!
    expect(titleId).toBeTruthy()
    const title = document.getElementById(titleId)!
    expect(title.textContent).toBe('Settings Title')
    expect(screen.getByRole('dialog', { name: 'Settings Title' })).toBeTruthy()
  })

  it('names the close button through the visually-hidden close seat text', () => {
    mount()
    openPanel()
    const close = screen.getByRole('button', { name: 'Close' })
    expect(close.hasAttribute('aria-label')).toBe(false)
    expect(close.textContent).toContain('Close')
  })

  it('holds only the Close control: no nav rail, no section buttons, no header actions', () => {
    // The household asked for the settings tabs and the configuration-file
    // action gone; the dialog's remaining controls are exactly one Close.
    const { renderSlot } = mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    const buttons = [...dialog.querySelectorAll('button')].map(button => button.textContent)
    expect(buttons).toEqual(['Close'])
    expect(dialog.querySelector('nav')).toBeNull()
    // The header's action cluster is gone: the shell renders exactly these seats
    // and the `settings.action` slot type is deleted from the contract, so there
    // is nothing left to fill.
    expect(new Set(renderSlot.mock.calls.map(call => call[0]))).toEqual(new Set([
      'settings.trigger', 'settings.header', 'settings.close', 'settings.section', 'settings.onboarding',
    ]))
    expect(screen.queryByText('Open configuration file')).toBeNull()
  })
})

describe('SettingsPanel close paths', () => {
  it('closes via the header button', () => {
    mount()
    openPanel()
    fireEvent.click(screen.getByRole('button', { name: 'Close' }))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via a mask click', () => {
    mount()
    openPanel()
    const dialog = screen.getByRole('dialog')
    fireEvent.click(dialog.parentElement!.firstElementChild!)
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('closes via document-level Escape and unhooks the listener with the panel', () => {
    mount()
    openPanel()
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    // Ignored while closed (listener removed with the panel) and non-Escape
    // keys are ignored while open.
    fireEvent.keyDown(document, { key: 'Escape' })
    openPanel()
    fireEvent.keyDown(document, { key: 'Enter' })
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('lands focus on the close button when the dialog opens', () => {
    mount()
    openPanel()
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }))
  })
})

describe('SettingsPanel section rendering', () => {
  it('renders the registered section directly, with no nav', () => {
    // Opening Settings lands on the section rows immediately: the section slot
    // is called for the first registered id and nothing else renders.
    const { renderSlot } = mount({ sectionIds: ['general'] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-general')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(1)
    expect(sectionCalls[0]![2]).toEqual({ only: 'general' })
    // No navigation exists to reach a second section; the ids the ledger used to
    // project into rows are gone with the rail.
    expect(screen.getByRole('dialog').querySelector('nav')).toBeNull()
    for (const name of ['General', 'Models', 'Agent presets']) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
  })

  it('renders whichever section the ledger lists first, not a hardcoded id', () => {
    // After the Learn More and Plugins packages are gone General is the only
    // registrant — but the shell does not name it. A different first entry
    // renders instead, which is what keeps this honest if the set changes.
    const { renderSlot } = mount({ sectionIds: ['models', 'general'] })
    openPanel()
    expect(screen.getByTestId('section-models')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.section')
    expect(sectionCalls.at(-1)![2]).toEqual({ only: 'models' })
  })

  it('follows a ledger change to the first entry', () => {
    const { bump } = mount({ sectionIds: ['general', 'models'] })
    openPanel()
    expect(screen.getByTestId('section-general')).toBeTruthy()
    bump(['models'])
    expect(screen.getByTestId('section-models')).toBeTruthy()
    expect(screen.queryByTestId('section-general')).toBeNull()
  })

  it('hands the section the shell-owned close affordance', () => {
    const { renderSlot } = mount({ sectionIds: ['general'] })
    openPanel()
    const sectionCall = renderSlot.mock.calls.find(call => call[0] === 'settings.section')!
    act(() => { (sectionCall[1] as { close: () => void }).close() })
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders an empty content column when the ledger is empty', () => {
    const { renderSlot } = mount({ sectionIds: [] })
    openPanel()
    expect(screen.getByRole('dialog')).toBeTruthy()
    const sectionCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.section')
    expect(sectionCalls).toHaveLength(0)
  })

  it('drops the ledger subscription on unmount', () => {
    const { view, listeners } = mount()
    expect(listeners.size).toBe(1)
    view.unmount()
    expect(listeners.size).toBe(0)
  })
})

describe('SettingsRoot onboarding handoff', () => {
  it('mounts onboarding steps in order and transfers ownership only on completion', () => {
    const { renderSlot } = mount()
    const first = renderSlot.mock.calls.find(call => call[0] === 'settings.onboarding')
    expect(first?.[1]).toMatchObject({ stepId: 'welcome' })
    expect(first?.[2]).toEqual({ only: 'welcome' })
    act(() => {
      (first?.[1] as { complete: () => void }).complete()
      ;(first?.[1] as { complete: () => void }).complete()
    })
    const onboardingCalls = renderSlot.mock.calls.filter(call => call[0] === 'settings.onboarding')
    const second = onboardingCalls.at(-1)
    expect(second?.[1]).toMatchObject({ stepId: 'credential' })
    expect(second?.[2]).toEqual({ only: 'credential' })

    // The step opens the panel itself; with one section there is no id to name.
    expect(second?.[1]).not.toHaveProperty('openSection')
    act(() => {
      (second?.[1] as { openSettings: () => void }).openSettings()
    })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-general')).toBeTruthy()

    cleanup()
    const inactive = mount({ onboardingActive: false }).renderSlot.mock.calls
      .filter(call => call[0] === 'settings.onboarding')
    expect(inactive).toHaveLength(0)
  })

  it('paints no takeover chrome of its own around the mounted step', () => {
    // The chrome (mask, opaque stage, #root inert) belongs to the step via
    // the step-owned dialog surface — a mounted-but-deciding step that
    // renders null must show and block nothing (the reload white-flash fix;
    // onboarding-surface.spec.tsx pins the primitive's half).
    const appRoot = document.createElement('div')
    appRoot.id = 'root'
    document.body.append(appRoot)
    const { view } = mount()
    expect(view.container.querySelector('[class*="onboarding"]')).toBeNull()
    expect(document.body.querySelector('[class*="onboarding"]')).toBeNull()
    expect(appRoot.inert).not.toBe(true)
    view.unmount()
    appRoot.remove()
  })
})

describe('SettingsRoot viewing-state persistence', () => {
  it('reopens the panel when the store rehydrates open (the reload case)', () => {
    // This is what a reload renders: the registration's store came back from
    // dsh.settings.shell with the panel open, and the very first paint after
    // boot shows the panel rather than an empty frame.
    mount({ sectionIds: ['general'], seed: (actions) => { actions.open() } })
    expect(screen.getByRole('dialog')).toBeTruthy()
    expect(screen.getByTestId('section-general')).toBeTruthy()
  })

  it('stays closed across a reload that left it closed', () => {
    // open then close is the sequence a reader performs; the stored value is
    // the closed state, so the boot render must not surprise-reopen the panel.
    mount({ seed: (actions) => { actions.open(); actions.close() } })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'Settings' }).getAttribute('aria-expanded')).toBe('false')
  })

  it('writes the open state into the store, not component state', () => {
    const { shell } = mount()
    expect(shell.getSnapshot()).toEqual({ open: false })
    openPanel()
    expect(shell.getSnapshot()).toEqual({ open: true })
  })

  it('each close path records the closed state', () => {
    for (const closeIt of [
      () => { fireEvent.click(screen.getByRole('button', { name: 'Close' })) },
      () => { fireEvent.click(screen.getByRole('dialog').parentElement!.firstElementChild!) },
      () => { fireEvent.keyDown(document, { key: 'Escape' }) },
    ]) {
      cleanup()
      const { shell } = mount()
      openPanel()
      expect(shell.getSnapshot().open).toBe(true)
      closeIt()
      expect(shell.getSnapshot().open).toBe(false)
    }
  })
})
