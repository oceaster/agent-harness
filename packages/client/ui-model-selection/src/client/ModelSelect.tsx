/** Effort-only composer dropdown. The host's current model is never displayed or changed. */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** One selectable level: an adapter effort, the provider-default seat, or a policy track entry. */
interface EffortLevel {
  id: string | undefined
  name: string
  description: string | undefined
}

/** Render the effort menu the session's policy describes.
 * @param props - composer lock, injected policy face, directory snapshot, effort submission and locale.
 * @returns the effort trigger and its accessible, policy-governed dialog.
 */
export function ModelSelect({ locked, available, policy: policySource, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>) {
  const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
  const policy = useSyncExternalStore(fn => policySource.subscribe(fn), () => policySource.getSnapshot())
  const [open, setOpen] = useState(false)
  const [error, setError] = useState(false)
  const [draft, setDraft] = useState<number | null>(null)
  const root = useRef<HTMLDivElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const id = useId()
  const current = state.current
  const model = state.groups.find(group => group.id === current?.provider)?.models.find(item => item.id === current?.model)
  const reasoning = model?.reasoning
  const effective = current?.reasoningEffort ?? reasoning?.defaultEffort
  // A policy that carries its own track replaces the directory's offer: an
  // addressed worker conversation has no `session.models` to load, yet its
  // dialog still has to show where the delegated level sits.
  const track = policy.track
  const levels: EffortLevel[] = track !== undefined
    ? track.names.map(name => ({ id: name, name, description: undefined }))
    : reasoning === undefined ? [] : [
      ...(reasoning.defaultEffort === undefined ? [{ id: undefined, name: t('effort.providerDefault'), description: undefined }] : []),
      ...reasoning.efforts,
    ]
  const ownIndex = track !== undefined
    ? Math.min(Math.max(track.index, 0), Math.max(0, levels.length - 1))
    : Math.max(0, levels.findIndex(level => level.id === effective))
  // The tree bar: the highest effort used anywhere below this conversation,
  // never below the level this session itself runs at.
  const treeIndex = (policy.treeEfforts ?? [])
    .reduce((highest, effort) => Math.max(highest, levels.findIndex(level => level.id === effort)), -1)
  const barIndex = Math.min(Math.max(ownIndex, treeIndex), Math.max(0, levels.length - 1))
  // A read-only dialog has no draft by definition: its thumb IS the bar.
  const sliderIndex = policy.editable ? Math.min(draft ?? barIndex, Math.max(0, levels.length - 1)) : barIndex
  const preview = levels[sliderIndex]
  const levelName = reasoning?.efforts.find(level => level.id === effective)?.name ?? effective
  const shown = policy.word ?? preview?.name ?? levelName ?? t('effort.providerDefault')
  const busy = state.status === 'selecting'
  const openable = policy.opens && !locked && !busy
  useEffect(() => { if (available) load() }, [available, load])
  useEffect(() => {
    if (!open) return
    const outside = (event: MouseEvent): void => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', outside)
    return () => { document.removeEventListener('mousedown', outside) }
  }, [open])
  if (!available) return null
  const close = (): void => { setOpen(false); trigger.current?.focus() }
  const keyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') { event.preventDefault(); close(); return }
    if (event.target instanceof HTMLInputElement) {
      if (event.key === 'Enter') { event.preventDefault(); void choose(preview?.id) }
      return
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (!openable) return
      setDraft(null); setOpen(true); load()
    }
  }
  const choose = async (effort: string | undefined): Promise<void> => {
    // The lock: a read-only policy cannot submit, whatever gesture reaches
    // here — a pointer release, Enter on the slider, or a stale draft.
    if (!policy.editable || locked || current === null || busy) return
    if (effort === effective) { close(); return }
    setError(false)
    const accepted = await select({ provider: current.provider, model: current.model,
      ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    if (accepted) close()
    else setError(true)
  }
  return <div ref={root} className={css.root} onKeyDown={keyDown} onBlur={(event) => {
    if (event.relatedTarget instanceof Node && root.current?.contains(event.relatedTarget)) return
    setOpen(false)
  }}>
    <button ref={trigger} type="button" className={css.trigger} data-testid="agent-effort-trigger"
      aria-label={t('effort.aria', { effort: shown })}
      aria-haspopup={policy.opens ? 'dialog' : undefined} aria-expanded={policy.opens ? open : undefined}
      aria-controls={policy.opens && open ? id : undefined} disabled={!policy.opens || locked || busy}
      onClick={() => {
        if (!openable) return
        setOpen(!open); if (!open) { setDraft(null); setError(false); load() }
      }}>
      <span className={css.triggerLabel}>{t('menu.effort')}</span>
      <span className={css.triggerEffort}>{shown}</span><IconChevronDownOutline14 />
    </button>
    {policy.opens && open && <div id={id} className={css.menu} role="dialog" aria-label={t('menu.effort')} aria-busy={busy}>
      {state.status === 'loading' && <div className={css.status}>{t('effort.loading')}</div>}
      {(error || state.error !== null) && <div className={css.error} role="alert">
        <span>{t('effort.error')}</span><button type="button" className={css.retry} onClick={load}>{t('action.reload')}</button>
      </div>}
      {levels.length === 0 && state.status !== 'loading' && <div className={css.empty}>{t('effort.unavailable')}</div>}
      {levels.length > 0 && <>
        <div className={css.effortValue} aria-live="polite">{shown}</div>
        {preview?.description !== undefined && <p className={css.effortDescription}>{preview.description}</p>}
        <div className={css.sliderWrap}>
          <input type="range" className={css.effortSlider} min={0} max={Math.max(0, levels.length - 1)} step={1}
            value={sliderIndex} aria-label={t('effort.heading')} aria-valuetext={shown}
            disabled={!policy.editable || locked || busy || levels.length < 2}
            style={{ background: `linear-gradient(to right, var(--dsw-static-blue-500) ${levels.length < 2 ? 0 : sliderIndex / (levels.length - 1) * 100}%, var(--dsw-alias-border-l3) 0)` }}
            onChange={(event) => { if (!policy.editable) return; setDraft(Number(event.currentTarget.value)) }}
            onPointerUp={(event) => { void choose(levels[Number(event.currentTarget.value)]?.id) }}
            onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); void choose(preview?.id) } }}
          />
          <div className={css.sliderTicks} aria-hidden="true">{levels.map(level => <span key={level.id ?? 'default'} />)}</div>
        </div>
        <div className={css.sliderEnds}><span>{levels[0]?.name}</span><span>{levels.at(-1)?.name}</span></div>
      </>}
    </div>}
  </div>
}
