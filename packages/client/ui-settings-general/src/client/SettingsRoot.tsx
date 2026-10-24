/**
 * Settings shell root: the sidebar-foot trigger row plus the centered modal
 * panel (figma 501:29947, 1080x700) that renders the settings section itself.
 * There is no nav rail and no section switching — the household asked for the
 * tabs gone, so the panel is one full-width column: a title row (title text
 * from the `settings.header` seat, the shell-owned Close control beside it) over
 * the section, which stretches the full width rather than sitting in a remnant
 * content column beside an empty rail.
 *
 * The shell is still a pure composition face — every piece of text (trigger
 * label, panel title, close label, section content) arrives from registrants
 * through slots; accessible names resolve to that content (trigger: its own
 * text; dialog: aria-labelledby the title node; close: visually-hidden slot
 * text). The rendered section is whichever `settings.section` entry the ledger
 * lists first, never a hardcoded id: with one section registered there is
 * nothing to navigate, and a second registration would sit unreachable (a
 * composition error), not appear as a tab. Modal open state is the
 * registration's store state, not component state, so a reload restores the
 * panel the reader left behind (settings-shell-store.ts); the onboarding
 * coordinator mounts exactly one ordered registrant while the sessions-derived
 * empty-Hero fact is active. Visible dialog chrome belongs to the step, so a
 * mounted-but-deciding step paints nothing here.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import clsx from 'clsx'
import { IconCloseOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsRootComponentProps } from './shell-contract.ts'
import css from './SettingsRoot.module.css'

type PanelProps = {
  /** Id of the single section to render, or undefined while the ledger is empty. */
  sectionId: string | undefined
  renderSlot: SettingsRootComponentProps['renderSlot']
  onClose: () => void
}

/**
 * The modal layer: full-viewport mask + centered panel. Close paths: the
 * header button, a mask click, and document-level Escape (mounted only while
 * open, so the listener lifetime is the panel's).
 */
function SettingsPanel({ sectionId, renderSlot, onClose }: PanelProps) {
  const titleId = useId()

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [onClose])

  // Baseline focus management: entering the dialog lands on the close button.
  const closeButton = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { closeButton.current?.focus() }, [])

  return (
    <div className={css.overlay} role="presentation">
      <div className={css.mask} aria-hidden="true" onClick={onClose} />
      <div className={css.panel} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className={css.header}>
          <div className={css.title} id={titleId}>{renderSlot('settings.header', {})}</div>
          <button ref={closeButton} type="button" className={css.close} onClick={onClose}>
            <IconCloseOutline16 size={14} />
            <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
          </button>
        </div>
        <div className={css.options}>
          {sectionId !== undefined
            && renderSlot('settings.section', { close: onClose }, { only: sectionId })}
        </div>
      </div>
    </div>
  )
}

/**
 * Render the settings trigger and panel.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the settings shell element tree.
 */
export function SettingsRoot(props: SettingsRootComponentProps) {
  const { wide, useSectionIds, useOnboardingSteps, useSessions, renderSlot, useStore, actions } = props
  // The reader's position in this surface, held in the registration's store so
  // it survives a reload: a panel left open comes back open, and one left
  // closed comes back closed rather than surprising the reader.
  const open = useStore(state => state.open)
  const [completedOnboarding, setCompletedOnboarding] = useState<ReadonlySet<string>>(() => new Set())
  // A same-host embedding shell owns the global Settings entry. Commands are
  // accepted only from the actual parent and its exact referrer origin.
  const [parentOrigin] = useState(() => {
    try {
      const referrer = new URL(document.referrer)
      return window.parent !== window && referrer.hostname === location.hostname
        && referrer.protocol === location.protocol ? referrer.origin : null
    } catch { return null }
  })
  const settingsOnly = parentOrigin !== null && new URLSearchParams(location.search).get('eServerSettings') === '1'
  const close = useCallback(() => {
    actions.close()
    if (parentOrigin) window.parent.postMessage({ type: 'e-server:settings:closed' }, parentOrigin)
  }, [actions, parentOrigin])
  useEffect(() => {
    if (!parentOrigin) return
    const receive = (event: MessageEvent<unknown>) => {
      const data = event.data
      if (event.source !== window.parent || event.origin !== parentOrigin
        || data === null || typeof data !== 'object' || !('type' in data)) return
      if (data.type === 'e-server:settings:open') actions.open()
      if (data.type === 'e-server:settings:close') close()
    }
    window.addEventListener('message', receive)
    if (settingsOnly) actions.open()
    window.parent.postMessage({ type: 'e-server:settings:ready' }, parentOrigin)
    return () => { window.removeEventListener('message', receive) }
  }, [actions, close, parentOrigin, settingsOnly])
  const openSettings = useCallback(() => { actions.open() }, [actions])

  // The ledger tick keeps the rendered section fresh: registrants come and go
  // with plugin activation, and the trigger/header/close seats re-render
  // through their own outlets' subscriptions.
  const sectionIds = useSectionIds(s => s)
  const onboardingSteps = useOnboardingSteps(s => s)
  const onboardingActive = useSessions(state =>
    state.phase === 'ready'
    && (state.current === undefined || state.byId[state.current]?.blank === true))
  const onboardingStep = onboardingActive
    ? onboardingSteps.find(step => !completedOnboarding.has(step.id))
    : undefined

  useEffect(() => {
    if (onboardingActive) return
    setCompletedOnboarding(new Set())
  }, [onboardingActive])

  const completeOnboardingStep = useCallback((id: string) => {
    setCompletedOnboarding((previous) => {
      if (previous.has(id)) return previous
      return new Set([...previous, id])
    })
  }, [])

  return (
    <>
      {settingsOnly && <style>{'#root{visibility:hidden}[data-host-settings-only]{visibility:visible}'}</style>}
      {!parentOrigin && <button
        type="button"
        className={clsx(css.trigger, !wide && css.rail)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => { actions.open() }}
      >
        {renderSlot('settings.trigger', { wide })}
      </button>}
      {open && (
        <div data-host-settings-only={settingsOnly ? '' : undefined}><SettingsPanel
          sectionId={sectionIds[0]}
          renderSlot={renderSlot}
          onClose={close}
        /></div>
      )}
      {/* Dialog chrome and `#root` inert ownership live inside each step's
          visible branch. A step still deciding (private facts loading)
          renders null, so nothing paints or blocks while it decides. The step
          opens the panel itself — there is one section and no navigation, so
          the handoff names no id. */}
      {!settingsOnly && onboardingStep !== undefined && renderSlot('settings.onboarding', {
        stepId: onboardingStep.id,
        complete: () => { completeOnboardingStep(onboardingStep.id) },
        openSettings,
      }, { only: onboardingStep.id })}
    </>
  )
}
