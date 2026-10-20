/** Read-only peer-agent history occupying the main chat tile. */
import { useEffect, useRef } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { InboxInjected } from './slots.ts'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import css from './InboxPanel.module.css'
import { AgentAvatar } from './AgentAvatar.tsx'

/** The channel page shares the sidebar's controller and refresh action. */
type ChannelPageProps = PropsRuntime<'conversation.page'> & PropsLocale<'inbox'>
  & InjectFace<{ hooks: Pick<InboxInjected['hooks'], 'channels'>; refreshChannel: () => void }>

/** Render the channel in the conversation column without an input or editing controls.
 * @param props - injected channel snapshot, refresh action and locale.
 * @returns the read-only channel transcript.
 */
export function ChannelPage({ useChannels, refreshChannel, t }: ChannelPageProps) {
  const state = useChannels(snapshot => snapshot)
  const transcript = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (transcript.current !== null) transcript.current.scrollTop = transcript.current.scrollHeight
  }, [state.messages.length, state.selected?.id])
  return <section className={css.channelPage} data-testid="agent-channel-page" aria-label={state.selected?.name ?? t('channel.title')}>
    <header className={css.channelHeader}>
      <div className={css.channelHeading}>
        <AgentAvatar agents={state.selected?.agents ?? []} label="↔" />
        <strong>{state.selected?.name ?? t('channel.title')}</strong>
      </div>
      <button type="button" className={css.channelReload} data-testid="agent-channel-refresh" onClick={refreshChannel}>
        {t('panel.refresh')}
      </button>
    </header>
    <div className={css.channelScroll} ref={transcript} data-testid="agent-channel-history">
      <div className={css.channelContent}>
        {state.error !== null && <p role="alert">{state.error}</p>}
        {state.loading && <p>{t('channel.loading')}</p>}
        {!state.loading && state.messages.length === 0 && state.error === null && <p>{t('channel.empty')}</p>}
        {state.messages.map(message => <article className={css.channelMessage} key={message.id}
          data-testid="agent-channel-message" data-side={message.sender === state.selected?.agents[1] ? 'right' : 'left'}>
          <div className={css.channelMessageStack}>
            <header><strong>{message.sender}</strong>
              {message.priority === 'high' && <span>{t('channel.high')}</span>}
              <time dateTime={new Date(message.created * 1000).toISOString()}>{new Date(message.created * 1000).toLocaleString()}</time>
            </header>
            <p className={css.channelBubble}>{message.content}</p>
          </div>
        </article>)}
      </div>
    </div>
  </section>
}
