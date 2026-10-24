// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { ComponentProps } from 'react'
import type { ModelDirectoryState } from '../src/client/directory.ts'
import { ModelSelect } from '../src/client/ModelSelect.tsx'
import { ORDINARY_EFFORT_POLICY, type EffortPolicy } from '../src/client/slots.ts'
import { en, zh } from '../src/client/locales.ts'
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

/** The English view of the same lookup, for the strings Owen wrote in English. */
const tEn: ComponentProps<typeof ModelSelect>['t'] = (key, params) => {
  const template = (en as Record<string, string>)[key] ?? key
  return params === undefined
    ? template
    : template.replace(/\{(\w+)\}/g, (match, name: string) => name in params ? String(params[name]) : match)
}

const reasoning = {
  efforts: [
    { id: 'off', name: 'Off' },
    { id: 'low', name: 'Low' },
    { id: 'high', name: 'High' },
    { id: 'max', name: 'Max', description: 'Largest budget' },
  ],
  defaultEffort: 'low',
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
  function bench(overrides: Partial<ModelDirectoryState> = {}, options: {
    available?: boolean
    locked?: boolean
    policy?: EffortPolicy
    translate?: ComponentProps<typeof ModelSelect>['t']
  } = {}) {
    const directory = createSnapshotStore(state(overrides))
    const policy = createSnapshotStore<EffortPolicy>(options.policy ?? ORDINARY_EFFORT_POLICY)
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...directory.getSnapshot(), current: selection })
      return true
    })
    const load = vi.fn()
    const view = render(<ModelSelect available={options.available ?? true} locked={options.locked ?? false}
      policy={policy} directory={directory} select={select} load={load} t={options.translate ?? t} />)
    return { directory, policy, select, load, view }
  }
  it('previews discrete steps and commits on release without exposing or changing a model', async () => {
    const b = bench()
    const trigger = screen.getByTestId('agent-effort-trigger')
    expect(screen.queryByText('DeepSeek-V4-Flash')).toBeNull()
    fireEvent.click(trigger)
    const slider = screen.getByRole('slider')
    expect(slider.getAttribute('aria-valuetext')).toBe('Low')
    fireEvent.change(slider, { target: { value: '3' } })
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
    fireEvent.change(slider, { target: { value: '3' } })
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
  it('hides the control for a session that renders nothing and disables a composer-locked one', () => {
    const b = bench({}, { available: false })
    expect(screen.queryByRole('button')).toBeNull()
    expect(b.load).not.toHaveBeenCalled()
    b.view.unmount()
    bench({}, { locked: true })
    expect(screen.getByTestId<HTMLButtonElement>('agent-effort-trigger').disabled).toBe(true)
  })
  it('paints no heading element and keeps the string only as the slider accessible name', () => {
    bench({}, { translate: tEn })
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    // Owen: "Remove 'Thinking Effort' element." Nothing paints it any more.
    expect(screen.queryByText('Thinking effort')).toBeNull()
    expect(screen.queryByText(zh['effort.heading'])).toBeNull()
    // The key is still READ, as the slider's accessible name and nothing else.
    expect(screen.getByRole('slider').getAttribute('aria-label')).toBe('Thinking effort')
    // The dialog itself is named by menu.effort, which is unchanged copy.
    expect(screen.getByRole('dialog').getAttribute('aria-label')).toBe('Effort')
  })
})

describe('the four effort policies, in Owen’s words', () => {
  function bench(overrides: Partial<ModelDirectoryState> = {}, options: {
    available?: boolean
    locked?: boolean
    policy?: EffortPolicy
    translate?: ComponentProps<typeof ModelSelect>['t']
  } = {}) {
    const directory = createSnapshotStore(state(overrides))
    const policy = createSnapshotStore<EffortPolicy>(options.policy ?? ORDINARY_EFFORT_POLICY)
    const select = vi.fn(async (selection: ModelSelection) => {
      directory.set({ ...directory.getSnapshot(), current: selection })
      return true
    })
    const load = vi.fn()
    const view = render(<ModelSelect available={options.available ?? true} locked={options.locked ?? false}
      policy={policy} directory={directory} select={select} load={load} t={options.translate ?? tEn} />)
    return { directory, policy, select, load, view }
  }
  it('Diana: on screen reading Off, and no dialog can be opened', () => {
    const b = bench({}, { policy: { word: 'Off', opens: false, editable: false } })
    const trigger = screen.getByTestId<HTMLButtonElement>('agent-effort-trigger')
    // Exactly Owen's words on screen: the label, then the fixed word.
    expect(trigger.textContent).toBe('EffortOff')
    expect(trigger.getAttribute('aria-label')).toBe('Choose effort, current Off')
    // "DISABLED & LOCKED": disabled, and it announces no dialog it cannot open.
    expect(trigger.disabled).toBe(true)
    expect(trigger.getAttribute('aria-haspopup')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBeNull()
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByRole('slider')).toBeNull()
    fireEvent.keyDown(trigger, { key: 'ArrowDown' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.select).not.toHaveBeenCalled()
  })
  it('Darwin: the same shape reading Max', () => {
    const b = bench({}, { policy: { word: 'Max', opens: false, editable: false } })
    const trigger = screen.getByTestId<HTMLButtonElement>('agent-effort-trigger')
    expect(trigger.textContent).toBe('EffortMax')
    expect(trigger.disabled).toBe(true)
    fireEvent.click(trigger)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(b.select).not.toHaveBeenCalled()
  })
  it('Delta: the dialog opens, the slider is locked, and the value always reads Dynamic', async () => {
    const b = bench({ current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' } },
      { policy: { word: 'Dynamic', opens: true, editable: false } })
    const trigger = screen.getByTestId<HTMLButtonElement>('agent-effort-trigger')
    expect(trigger.textContent).toBe('EffortDynamic')
    expect(trigger.disabled).toBe(false)
    expect(trigger.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(trigger)
    const slider = screen.getByRole<HTMLInputElement>('slider')
    // Whatever level is actually set, the control reads Dynamic.
    expect(slider.disabled).toBe(true)
    expect(slider.getAttribute('aria-valuetext')).toBe('Dynamic')
    expect(screen.getAllByText('Dynamic').length).toBeGreaterThan(1)
    // A locked dialog cannot write: no gesture reaches select().
    fireEvent.change(slider, { target: { value: '3' } })
    fireEvent.pointerUp(slider)
    fireEvent.keyDown(slider, { key: 'Enter' })
    await Promise.resolve()
    expect(b.select).not.toHaveBeenCalled()
    expect(screen.getAllByText('Dynamic').length).toBeGreaterThan(1)
  })
  it('Delta: the bar sits at the highest effort in the tree, the text still reads Dynamic', () => {
    const model = { current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' } }
    // Delta alone: the bar is Delta's own level.
    const alone = bench(model, { policy: { word: 'Dynamic', opens: true, editable: false } })
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    expect(screen.getByRole<HTMLInputElement>('slider').value).toBe('1')
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Dynamic')
    alone.view.unmount()
    // A descendant running Max lifts the bar; the value text is untouched.
    bench(model, { policy: { word: 'Dynamic', opens: true, editable: false, treeEfforts: ['max'] } })
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    expect(screen.getByRole<HTMLInputElement>('slider').value).toBe('3')
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Dynamic')
    // A descendant BELOW Delta's own level never lowers the bar.
    cleanup()
    bench(model, { policy: { word: 'Dynamic', opens: true, editable: false, treeEfforts: ['off'] } })
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    expect(screen.getByRole<HTMLInputElement>('slider').value).toBe('1')
  })
  it('Delta: a worker whose level moves moves the bar, with no second data path', () => {
    const b = bench({ current: { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' } },
      { policy: { word: 'Dynamic', opens: true, editable: false } })
    fireEvent.click(screen.getByTestId('agent-effort-trigger'))
    expect(screen.getByRole<HTMLInputElement>('slider').value).toBe('1')
    act(() => { b.policy.set({ word: 'Dynamic', opens: true, editable: false, treeEfforts: ['high'] }) })
    expect(screen.getByRole<HTMLInputElement>('slider').value).toBe('2')
    expect(screen.getByRole('slider').getAttribute('aria-valuetext')).toBe('Dynamic')
  })
  // PARKED (Owen deferred the worker case on 2026-10-24): the control still
  // renders this shape correctly and this test keeps it honest, but no
  // deployment publishes a `track` yet and the seat is never mounted for a
  // read-only worker conversation. Kept, not deleted, so un-parking is a
  // wiring change rather than a resurrection.
  it('a parked read-only shape: locked at the level a policy track supplies', async () => {
    const b = bench({ current: null, groups: [] }, {
      policy: { word: 'High', opens: true, editable: false, track: { names: ['Off', 'Low', 'High', 'Max'], index: 2 } },
    })
    const trigger = screen.getByTestId<HTMLButtonElement>('agent-effort-trigger')
    expect(trigger.textContent).toBe('EffortHigh')
    expect(trigger.disabled).toBe(false)
    fireEvent.click(trigger)
    const slider = screen.getByRole<HTMLInputElement>('slider')
    expect(slider.disabled).toBe(true)
    expect(slider.value).toBe('2')
    expect(slider.getAttribute('aria-valuetext')).toBe('High')
    fireEvent.pointerUp(slider)
    fireEvent.keyDown(slider, { key: 'Enter' })
    await Promise.resolve()
    expect(b.select).not.toHaveBeenCalled()
  })
})
