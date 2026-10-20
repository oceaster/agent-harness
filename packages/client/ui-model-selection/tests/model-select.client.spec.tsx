// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { zh } from '../src/client/locales.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'

// The seat's key domain is model ∪ common; the stub mirrors the real lookup
// chain: package dictionary, then common vocabulary, then the key.
const t: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (zh as Record<string, string>)[key]
    ?? (commonZh as Record<string, string>)[key]
    ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'high',
}

function state(overrides: Partial<ModelDirectoryState> = {}): ModelDirectoryState {
  return {
    current: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    routable: true,
    groups: [{
      id: 'deepseek-official',
      name: 'DeepSeek',
      models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', reasoning }],
    }],
    failures: [],
    status: 'ready',
    error: null,
    ...overrides,
  }
}

afterEach(cleanup)

describe('effort-only slider', () => {
  function bench(overrides: Partial<ModelDirectoryState> = {}, available = true, locked = false) {
    const directory = createSnapshotStore(state(overrides))
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...directory.getSnapshot(), current: selection })
      return true
    })
    const load = vi.fn()
    const view = render(<ModelSelect available={available} locked={locked} directory={directory} select={select} load={load} t={t} />)
    return { directory, select, load, view }
  }
  it('previews discrete steps and commits on release without exposing or changing a model', async () => {
    const b = bench()
    const trigger = screen.getByTestId('agent-effort-trigger')
    expect(screen.queryByText('DeepSeek-V4-Flash')).toBeNull()
    fireEvent.click(trigger)
    const slider = screen.getByRole('slider')
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    fireEvent.change(slider, { target: { value: '2' } })
    expect(slider.getAttribute('aria-valuetext')).toBe('Max')
    expect(b.select).not.toHaveBeenCalled()
    fireEvent.pointerUp(slider)
    await waitFor(() =>{  expect(b.select).toHaveBeenCalledWith({
      provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'max',
    }) })
    await waitFor(() =>{  expect(screen.queryByRole('slider')).toBeNull() })
    expect(trigger.getAttribute('aria-label')).toBe('选择推理强度，当前 Max')
  })
  it('allows keyboard commit and Escape cancellation', async () => {
    const b = bench()
    const trigger = screen.getByTestId('agent-effort-trigger')
    fireEvent.click(trigger)
    let slider = screen.getByRole('slider')
    fireEvent.change(slider, { target: { value: '0' } })
    fireEvent.keyDown(slider, { key: 'Escape' })
    expect(b.select).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(trigger)
    fireEvent.click(trigger)
    slider = screen.getByRole('slider')
    expect((slider as HTMLInputElement).value).toBe('1')
    fireEvent.change(slider, { target: { value: '2' } })
    fireEvent.keyDown(slider, { key: 'Enter' })
    await waitFor(() =>{  expect(b.select).toHaveBeenCalledOnce() })
  })
  it('does not submit the same effort', () => {
    const b = bench()
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    fireEvent.pointerUp(screen.getByRole('slider'))
    expect(b.select).not.toHaveBeenCalled()
  })
  it('does not offer another model when effort metadata is unavailable', () => {
    bench({ current: { provider: 'deepseek-official', model: 'removed-model', reasoningEffort: 'high' } })
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    expect(screen.queryByRole('slider')).toBeNull()
    expect(screen.queryByText('DeepSeek-V4-Flash')).toBeNull()
    expect(screen.getByText(zh['effort.unavailable'])).toBeTruthy()
  })
  it('includes provider default only when no configured effort default exists', () => {
    bench({ groups: [{ id: 'deepseek-official', name: 'Secret provider', models: [{
      id: 'deepseek-v4-flash', name: 'Secret model', reasoning: { efforts: [{ id: 'standard', name: 'Standard' }] },
    }] }] })
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Default')
    expect(screen.queryByText('Secret model')).toBeNull()
  })
  it('hides subagent controls and disables locked controls', () => {
    const b = bench({}, false)
    expect(screen.queryByRole('button')).toBeNull()
    expect(b.load).not.toHaveBeenCalled()
    b.view.unmount()
    bench({}, true, true)
    expect((screen.getByTestId('agent-effort-trigger')).disabled).toBe(true)
  })
})
