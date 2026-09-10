import { useEffect, useState } from 'react'
import type { TeamOverview, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import type { TeamActionResult } from './TeamAction.tsx'
import { Button, StateDot, PanelSection, PanelEntry, PanelActions } from '@deepseek-ai/dsh-client-ui-primitives'
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

/** Follow descendant conversations whenever the Team activity snapshot changes. */
export function TeamConversations({ view, load, t, open, reportError }: TeamConversationsProps) {
  const [revision, setRevision] = useState(0)
  const [directory, setDirectory] = useState<
    | { status: 'loading' }
    | { status: 'ready'; entries: TeamView['subagents'] }
    | { status: 'error'; message: string }
  >({ status: 'loading' })
  useEffect(() => {
    const controller = new AbortController()
    load(controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setDirectory(result.ok
        ? { status: 'ready', entries: result.value }
        : { status: 'error', message: `${result.error.message} (${result.error.code})` })
    }, (reason: unknown) => {
      if (!controller.signal.aborted) setDirectory({ status: 'error', message: String(reason) })
    })
    return () => { controller.abort() }
  }, [load, revision, view])
  const nameOf = (id: string, recordedName = id): string => {
    const member = view.members.find(candidate => candidate.id === id)
    if (member !== undefined) return member.name
    const entry = directory.status === 'ready' ? directory.entries.find(candidate => candidate.id === id) : undefined
    return entry?.kind === 'child' ? entry.label ?? recordedName : recordedName
  }
  return (
    <PanelSection title={t('conversations')} actions={directory.status === 'error' && (
      <Button size="touch" onClick={() => { setRevision(current => current + 1) }}>{t('refreshConversations')}</Button>
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
  )
}
