// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type {
  SidebarFooterActionOwnerProps, SidebarRootComponentProps, SidebarSectionOwnerProps,
  SidebarSettingsOwnerProps,
} from '../src/client/contract/slots.ts'
import { SidebarRoot } from '../src/client/SidebarRoot.tsx'
import { en } from '../src/client/locales.ts'

// English-dictionary translate stub: the shell renders the same copy the
// assertions below query by accessible name.
const t: SidebarRootComponentProps['t'] = key => (en as Record<string, string>)[key] ?? key

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

// The shell never reads the global hooks itself, but they ride the standard
// props share; stub them as never-called functions.
const neverHook = (() => { throw new Error('shell must not read global hooks') }) as never

function mountShell({ collapsed = false, width = 300, portrait = false }: {
  collapsed?: boolean
  width?: number
  portrait?: boolean
} = {}) {
  const toggleSidebar = vi.fn()
  let regionOwner: SidebarSectionOwnerProps | undefined
  let settingsOwner: SidebarSettingsOwnerProps | undefined
  let footerActionOwner: SidebarFooterActionOwnerProps | undefined
  let current = { collapsed, width, portrait }
  const root = () => (
    <SidebarRoot
      collapsed={current.collapsed} width={current.width} portrait={current.portrait}
      useSessions={neverHook} useWorkspaces={neverHook}
      toggleSidebar={toggleSidebar} t={t}
      renderSlot={((
        key: string,
        owner: SidebarFooterActionOwnerProps | SidebarSectionOwnerProps | SidebarSettingsOwnerProps,
      ) => {
        if (key === 'sidebar.settings') {
          settingsOwner = owner
          return <div data-testid="settings-seat" data-wide={owner.wide} />
        }
        if (key === 'sidebar.footer.action') {
          footerActionOwner = owner
          return <div data-testid="footer-action-seat" data-wide={owner.wide} />
        }
        regionOwner = owner as SidebarSectionOwnerProps
        return <div data-testid="region" data-wide={owner.wide} />
      }) as SidebarRootComponentProps['renderSlot']}
    />
  )
  const view = render(root())
  return {
    toggleSidebar,
    regionOwner: () => {
      if (regionOwner === undefined) throw new Error('region owner not rendered')
      return regionOwner
    },
    settingsOwner: () => {
      if (settingsOwner === undefined) throw new Error('settings owner not rendered')
      return settingsOwner
    },
    footerActionOwner: () => {
      if (footerActionOwner === undefined) throw new Error('footer action owner not rendered')
      return footerActionOwner
    },
    rerender(next: Partial<typeof current>) {
      current = { ...current, ...next }
      view.rerender(root())
    },
  }
}

describe('SidebarRoot shell', () => {
  it('routes the column toggle and offers no New Session control', () => {
    const b = mountShell()
    // The expanded inbox owns the fold control in its header.
    expect(screen.queryAllByRole('button', { name: 'New Session' })).toHaveLength(0)
    expect(screen.queryAllByRole('button', { name: 'New session' })).toHaveLength(0)
    expect(screen.queryByText('New Session')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull()
    b.regionOwner().collapseSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('hands the region its wide flag and clamps expandSidebar to the collapsed state', () => {
    const b = mountShell()
    expect(b.regionOwner().wide).toBe(true)
    // The settings seat rides the same wide flag (ui-settings renders the row).
    expect(b.settingsOwner().wide).toBe(true)
    expect(b.footerActionOwner().wide).toBe(true)
    // Expanded: the request is a no-op (no accidental collapse).
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).not.toHaveBeenCalled()
  })

  it('keeps the region mounted through collapse and expands on its request', () => {
    vi.useFakeTimers()
    const b = mountShell()
    b.rerender({ collapsed: true })
    // Wide content survives the crossfade window, then settles into the rail.
    expect(b.regionOwner().wide).toBe(true)
    vi.advanceTimersByTime(200)
    b.rerender({})
    expect(b.regionOwner().wide).toBe(false)
    expect(b.footerActionOwner().wide).toBe(false)
    expect(screen.getByTestId('region')).toBeTruthy()
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('renders statically collapsed on a cold start (no crossfade classes)', () => {
    const b = mountShell({ collapsed: true })
    expect(b.regionOwner().wide).toBe(false)
    expect(screen.getByRole('button', { name: 'Open sidebar' })).toBeTruthy()
  })

  it('portrait floats the expand control over the chat under its own name', () => {
    const b = mountShell({ collapsed: true, portrait: true })
    const expand = screen.getByTestId('ui-sidebar-expand')
    expect(expand.getAttribute('aria-label')).toBe('Expand inbox')
    // Landscape keeps the column-fold copy: nothing about it changed.
    expect(screen.queryByRole('button', { name: 'Open sidebar' })).toBeNull()
    b.regionOwner().expandSidebar()
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('the rail expand control folds the column through the layout service', () => {
    const b = mountShell({ collapsed: true, portrait: true })
    fireEvent.click(screen.getByTestId('ui-sidebar-expand'))
    expect(b.toggleSidebar).toHaveBeenCalledOnce()
  })

  it('hands the region the portrait flag and a collapse-on-selection that is portrait and expanded only', () => {
    const expanded = mountShell({ portrait: true })
    expect(expanded.regionOwner().portrait).toBe(true)
    // Expanded portrait: a selection collapses the column.
    expanded.regionOwner().collapseOnSelection?.()
    expect(expanded.toggleSidebar).toHaveBeenCalledOnce()
    cleanup()

    // Already collapsed: the collapse request must not flip it back open (the
    // narrow toggle inverts), so it is a no-op.
    const rail = mountShell({ collapsed: true, portrait: true })
    rail.regionOwner().collapseOnSelection?.()
    expect(rail.toggleSidebar).not.toHaveBeenCalled()
    cleanup()

    // Landscape: a selection never folds the column, expanded or not.
    const landscape = mountShell({ portrait: false })
    expect(landscape.regionOwner().portrait).toBe(false)
    landscape.regionOwner().collapseOnSelection?.()
    expect(landscape.toggleSidebar).not.toHaveBeenCalled()
  })
})
