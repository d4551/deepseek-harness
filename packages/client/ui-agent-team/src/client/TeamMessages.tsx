import type { TeamOverview } from '@deepseek-ai/dsh-agent-team/client'
import { PanelSection, PanelEntry, PanelActions, MessageBody, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import { memberLabel } from './member-label.ts'

/** Durable messages exchanged by workspace agents, including delivery state. */
export function TeamMessages({ view, t }: { view: TeamOverview; t: (key: TeamKey) => string }) {
  const nameOf = (id: string, recordedName = id): string => {
    const member = view.members.find(candidate => candidate.id === id)
    return member === undefined ? recordedName : memberLabel(member, t)
  }
  return <PanelSection title={t('messages')} description={t('messagesDescription')} actions={<Pill>{view.messages.length}</Pill>}>
    {view.messages.length === 0 && <p>{t('noMessages')}</p>}
    <div role="log" aria-label={t('messages')}>
      {view.messages.map(message => <PanelEntry key={message.id}>
        <PanelActions>
          <span className="dsw-settings-cell-title">{nameOf(message.senderId, message.senderName)} → {nameOf(message.targetId)}</span>
          <Pill>{t(message.delivered ? 'delivered' : 'queued')}</Pill>
        </PanelActions>
        <MessageBody>{message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')}</MessageBody>
        {message.content.some(block => block.type !== 'text') && <p>{t('messageAttachments')}</p>}
      </PanelEntry>)}
    </div>
  </PanelSection>
}
