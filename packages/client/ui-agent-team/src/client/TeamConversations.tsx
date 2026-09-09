import { useEffect, useState } from 'react'
import type { TeamOverview, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import type { TeamActionResult } from './TeamAction.tsx'
import { Button, StateDot, PanelStack, PanelSection, PanelEntry, PanelActions, MessageBody, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'

/** A descriptor-backed conversation returned by the Team service. */
export type TeamConversation = Extract<TeamView['subagents'][number], { kind: 'child' }>

interface TeamConversationsProps {
  view: TeamOverview
  load: (signal: AbortSignal) => Promise<TeamActionResult<TeamView['subagents']>>
  t: (key: TeamKey) => string
  open: (entry: TeamConversation) => Promise<void>
  reportError: (reason: unknown) => void
}

/** Render descendant conversations and the durable peer-message exchange. */
export function TeamConversations({ view, load, t, open, reportError }: TeamConversationsProps) {
  const [revision, setRevision] = useState(0)
  const [directory, setDirectory] = useState<
    | { status: 'loading' }
    | { status: 'ready'; entries: TeamView['subagents'] }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    setDirectory({ status: 'loading' })
    load(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setDirectory(result.ok
        ? { status: 'ready', entries: result.value }
        : { status: 'error', message: `${result.error.message} (${result.error.code})` })
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setDirectory({ status: 'error', message: String(reason) })
    })
    return () => { controller.abort() }
  }, [load, revision])
  const nameOf = (id: string): string => {
    const member = view.members.find(candidate => candidate.id === id)
    if (member !== undefined) return member.name
    const entry = directory.status === 'ready' ? directory.entries.find(candidate => candidate.id === id) : undefined
    return entry?.kind === 'child' ? entry.label ?? id : id
  }
  return (
    <PanelStack>
      <PanelSection title={t('messages')} description={t('messagesDescription')} actions={<Pill>{view.messages.length}</Pill>}>
        {view.messages.length === 0 && <p>{t('noMessages')}</p>}
        <div role="log" aria-label={t('messages')}>
          {view.messages.map(message => (
            <PanelEntry key={message.id}>
              <PanelActions>
                <strong>{message.senderName} → {nameOf(message.targetId)}</strong>
                <Pill>{t(message.delivered ? 'delivered' : 'queued')}</Pill>
              </PanelActions>
              <MessageBody>{message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')}</MessageBody>
              {message.content.some(block => block.type !== 'text') && <p>{t('messageAttachments')}</p>}
            </PanelEntry>
          ))}
        </div>
      </PanelSection>
      <PanelSection title={t('conversations')} actions={(
        <Button disabled={directory.status === 'loading'} onClick={() => { setRevision(current => current + 1) }}>{t('refreshConversations')}</Button>
      )}>
        {directory.status === 'loading' && <p role="status">{t('loadingConversations')}</p>}
        {directory.status === 'error' && <p role="alert">{directory.message}</p>}
        {directory.status === 'ready' && directory.entries.length === 0 && <p>{t('noSubagents')}</p>}
        {directory.status === 'ready' && directory.entries.map(entry => entry.kind === 'diagnostic'
          ? <p key={entry.id} role="alert">{entry.id}: {t('conversationUnavailable')} ({entry.reason})</p>
          : (
            <PanelEntry key={entry.id}>
              <PanelActions>
                <StateDot state={entry.activity === 'running' ? 'ongoing' : 'inactive'} />
                <Button onClick={() => { open(entry).then(undefined, reportError) }}>{entry.label ?? nameOf(entry.id)}</Button>
              </PanelActions>
              <p>{t('parent')}: {nameOf(entry.parentId)} · {t(entry.activity === 'running' ? 'memberStatus.running' : 'memberStatus.inactive')}</p>
            </PanelEntry>
          ))}
      </PanelSection>
    </PanelStack>
  )
}
