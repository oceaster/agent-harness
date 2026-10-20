/** Read-only view of this person's peer-agent channel, with live delivery outcomes. */
import { useEffect, useRef, useState } from 'react'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChannelState } from './channel-controller.ts'
import css from './InboxPanel.module.css'
import type { InboxPanelProps } from './slots.ts'
import { useFocusTrap } from './ConfirmClearDialog.tsx'

/** Render the selected channel without changing the active agent conversation. */
export function ChannelDialog({ state, close, refresh, clear, t }: {
  state: ChannelState
  close: () => void
  refresh: () => void
  clear: () => void
  t: InboxPanelProps['t']
}) {
  const [confirm, setConfirm] = useState(false)
  useEffect(() => { setConfirm(false) }, [state.selected])
  useFocusTrap(state.selected !== null, '[data-testid="agent-channel-refresh"]')
  const transcript = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (transcript.current !== null) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [state.messages.length])
  return <Modal open={state.selected !== null} onClose={close} title={state.selected?.name ?? t('channel.title')}
    closeLabel={t('dialog.close')}
    description={t('channel.body')}
    className={css.channelDialog ?? ''}>
    <div data-testid="agent-channel-history">
      <button type="button" className={css.channelReload} data-testid="agent-channel-refresh" onClick={refresh}>{t('channel.refresh')}</button>
      <button type="button" className={css.channelReload} onClick={() => { setConfirm(true) }}>{t('channel.clear')}</button>
      {confirm && <div role="alert">
        <p>{t('channel.clearBody')}</p>
        <button type="button" onClick={() => { setConfirm(false); clear() }}>{t('channel.confirmClear')}</button>
        <button type="button" onClick={() => { setConfirm(false) }}>{t('dialog.cancel')}</button>
      </div>}
      {state.error !== null && <p role="alert">{state.error}</p>}
      {state.loading && <p>{t('channel.loading')}</p>}
      {!state.loading && state.messages.length === 0 && state.error === null && <p>{t('channel.empty')}</p>}
      <div className={css.channelTranscript} ref={transcript}>
        {state.messages.map(message => <article className={css.channelMessage} key={message.id} data-testid="agent-channel-message">
          <header><strong>{message.sender} → {message.recipient}</strong><span>{message.priority === 'high' ? t('channel.high') + ' · ' : ''}{message.status}</span></header>
          <p>{message.content}</p>
          <time dateTime={new Date(message.created * 1000).toISOString()}>{new Date(message.created * 1000).toLocaleString()}</time>
        </article>)}
      </div>
    </div>
  </Modal>
}
