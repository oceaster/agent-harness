/**
 * The Clear confirmation: the menu's only action routes here, and here alone
 * calls `POST /clear`. The dialog names the agent (from the API payload) and
 * states that the messages are permanently deleted.
 *
 * The shared `Modal` primitive owns the portal, the mask, `role="dialog"`,
 * `aria-modal`, Escape, and mask-click cancellation. What it does not own is a
 * focus trap, so this component adds one: Tab and Shift+Tab stay inside the
 * dialog while it is open, and focus enters on the Cancel button (the safe
 * default for a destructive confirm).
 */
import { useEffect } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InboxPanelProps } from './slots.ts'
import css from './InboxPanel.module.css'

/** Elements the trap cycles through inside the open dialog. */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])'

/** The safe landing spot on open; also the first stop of the trap. */
const CANCEL_SELECTOR = '[data-testid="ui-inbox-confirm-cancel"]'

/**
 * Keep keyboard focus inside the open modal dialog.
 * @param open - whether the dialog is showing.
 */
function useFocusTrap(open: boolean): void {
  useEffect(() => {
    if (!open) return
    document.querySelector<HTMLElement>(CANCEL_SELECTOR)?.focus()
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      // The primitive renders the dialog element itself, so the trap resolves
      // it by its accessible role rather than through a ref it does not expose.
      const dialogs = document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')
      const dialog = dialogs[dialogs.length - 1]
      /* v8 ignore next -- the listener only exists while the primitive has mounted the dialog. */
      if (dialog === undefined) return
      const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE))
      const first = items[0]
      const last = items[items.length - 1]
      /* v8 ignore next -- a dialog with neither a close nor a footer control cannot be tabbed out of anyway. */
      if (first === undefined || last === undefined) return
      const active = document.activeElement
      const inside = active instanceof HTMLElement && items.includes(active)
      if (event.shiftKey) {
        if (!inside || active === first) {
          event.preventDefault()
          last.focus()
        }
        return
      }
      if (!inside || active === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [open])
}

/** Props of the confirmation dialog. */
export interface ConfirmClearDialogProps {
  /** Whether the dialog is showing. */
  open: boolean
  /** Display name of the row's agent, as the API returned it. */
  agentName: string
  /** The locale seat. */
  t: InboxPanelProps['t']
  /** Cancel: Escape, mask click, or the Cancel button. */
  onCancel: () => void
  /** Destructive confirm. */
  onConfirm: () => void
}

/**
 * Render the Clear confirmation.
 * @param props - open state, the agent's name, copy, and the two outcomes.
 * @returns the dialog tree (nothing while closed).
 */
export function ConfirmClearDialog({ open, agentName, t, onCancel, onConfirm }: ConfirmClearDialogProps) {
  useFocusTrap(open)
  return (
    <Modal
      open={open}
      onClose={onCancel}
      title={t('dialog.title', { name: agentName })}
      closeLabel={t('dialog.close')}
      description={t('dialog.body')}
      footer={(
        <div className={css.dialogActions}>
          <Button variant="outline" data-testid="ui-inbox-confirm-cancel" onClick={onCancel}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" data-testid="ui-inbox-confirm-clear" onClick={onConfirm}>
            {t('dialog.confirm')}
          </Button>
        </div>
      )}
    />
  )
}
