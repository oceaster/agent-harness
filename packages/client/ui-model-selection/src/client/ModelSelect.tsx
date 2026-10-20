/** Effort-only composer dropdown. The host's current model is never displayed or changed. */
import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelSelectInjected } from './slots.ts'
import css from './ModelSelect.module.css'

/** Render a single-level effort menu with the host-supported levels.
 * @param props - locked state, directory snapshot, effort submission and locale.
 * @returns the effort trigger and accessible radio menu.
 */
export function ModelSelect({ locked, available, directory, load, select, t }:
  ModelSelectInjected & { locked: boolean } & PropsLocale<'model'>) {
  const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot())
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
  const label = reasoning?.efforts.find(level => level.id === effective)?.name ?? effective ?? t('effort.providerDefault')
  const levels = reasoning === undefined ? [] : [
    ...(reasoning.defaultEffort === undefined ? [{ id: undefined, name: t('effort.providerDefault'), description: undefined }] : []),
    ...reasoning.efforts,
  ]
  const selectedIndex = Math.max(0, levels.findIndex(level => level.id === effective))
  const sliderIndex = Math.min(draft ?? selectedIndex, Math.max(0, levels.length - 1))
  const preview = levels[sliderIndex]
  const busy = state.status === 'selecting'
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
      event.preventDefault(); setDraft(null); setOpen(true); load()
    }
  }
  const choose = async (effort: string | undefined): Promise<void> => {
    if (current === null || busy) return
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
      aria-label={t('effort.aria', { effort: label })} aria-haspopup="dialog" aria-expanded={open}
      aria-controls={open ? id : undefined} disabled={locked || busy}
      onClick={() => { setOpen(!open); if (!open) { setDraft(null); setError(false); load() } }}>
      <span className={css.triggerLabel}>{t('menu.effort')}</span>
      <span className={css.triggerEffort}>{label}</span><IconChevronDownOutline14 />
    </button>
    {open && <div id={id} className={css.menu} role="dialog" aria-label={t('menu.effort')} aria-busy={busy}>
      <div className={css.effortHeading}>{t('effort.heading')}</div>
      {state.status === 'loading' && <div className={css.status}>{t('effort.loading')}</div>}
      {(error || state.error !== null) && <div className={css.error} role="alert">
        <span>{t('effort.error')}</span><button type="button" className={css.retry} onClick={load}>{t('action.reload')}</button>
      </div>}
      {levels.length === 0 && state.status !== 'loading' && <div className={css.empty}>{t('effort.unavailable')}</div>}
      {levels.length > 0 && <>
        <div className={css.effortValue} aria-live="polite">{preview?.name}</div>
        {preview?.description !== undefined && <p className={css.effortDescription}>{preview.description}</p>}
        <div className={css.sliderWrap}>
          <input type="range" className={css.effortSlider} min={0} max={Math.max(0, levels.length - 1)} step={1}
            value={sliderIndex} aria-label={t('effort.heading')} aria-valuetext={preview?.name}
            disabled={locked || busy || levels.length < 2}
            style={{ background: `linear-gradient(to right, var(--dsw-static-blue-500) ${levels.length < 2 ? 0 : sliderIndex / (levels.length - 1) * 100}%, var(--dsw-alias-border-l3) 0)` }}
            onChange={(event) => { setDraft(Number(event.currentTarget.value)) }}
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
