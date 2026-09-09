import type { TeamView } from '@deepseek-ai/dsh-agent-team/client'
import { Button, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import css from './TeamAction.module.css'

/** A descriptor-backed conversation returned by the Team service. */
export type TeamConversation = Extract<TeamView['subagents'][number], { kind: 'child' }>

interface TeamConversationsProps {
  view: TeamView
  t: (key: TeamKey) => string
  open: (entry: TeamConversation) => Promise<void>
  reportError: (reason: unknown) => void
}

/** Render descendant conversations and the durable peer-message exchange. */
export function TeamConversations({ view, t, open, reportError }: TeamConversationsProps) {
  const nameOf = (id: string): string => {
    const member = view.members.find(candidate => candidate.id === id)
    if (member !== undefined) return member.name
    const entry = view.subagents.find(candidate => candidate.id === id)
    return entry?.kind === 'child' ? entry.label ?? id : id
  }
  return (
    <>
      <section aria-label={t('conversations')}>
        <h3>{t('conversations')}</h3>
        {view.subagents.length === 0 && <p className={css.notice}>{t('noSubagents')}</p>}
        <div className={css.tasks}>
          {view.subagents.map(entry => entry.kind === 'diagnostic'
            ? <p key={entry.id} className={css.error}>{entry.id}: {t('conversationUnavailable')} ({entry.reason})</p>
            : (
              <Button key={entry.id} className={css.member} onClick={() => { open(entry).then(undefined, reportError) }}>
                <StateDot state={entry.activity === 'running' ? 'ongoing' : 'done'} />
                <span className={css.memberText}>
                  <span>{entry.label ?? nameOf(entry.id)}</span>
                  <small>{t('parent')}: {nameOf(entry.parentId)} · {t(entry.activity === 'running' ? 'memberStatus.running' : 'memberStatus.inactive')}</small>
                </span>
              </Button>
            ))}
        </div>
      </section>
      <section aria-label={t('messages')}>
        <h3>{t('messages')}</h3>
        {view.messages.length === 0 && <p className={css.notice}>{t('noMessages')}</p>}
        <div className={css.tasks}>
          {view.messages.map(message => (
            <article key={message.id} className={css.task}>
              <div className={css.taskTitle}>
                <strong>{message.senderName} → {nameOf(message.targetId)}</strong>
                <span>{t(message.delivered ? 'delivered' : 'queued')}</span>
              </div>
              <p>{message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')}</p>
              {message.content.some(block => block.type !== 'text') && <p>{t('messageAttachments')}</p>}
            </article>
          ))}
        </div>
      </section>
    </>
  )
}
