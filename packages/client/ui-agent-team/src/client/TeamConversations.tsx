import { useEffect, useState } from 'react'
import type { TeamOverview, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import type { TeamActionResult } from './TeamAction.tsx'
import { Button, IconRightUpOutline16, StateDot, PanelSection, PanelTable, PanelActions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import { memberLabel } from './member-label.ts'

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
  const nameOf = (id: string): string => {
    const member = view.members.find(candidate => candidate.id === id)
    if (member !== undefined) return memberLabel(member, t)
    const entry = directory.status === 'ready' ? directory.entries.find(candidate => candidate.id === id) : undefined
    return entry?.kind === 'child' && entry.label !== undefined ? entry.label : t('untitledConversation')
  }
  return (
    <PanelSection title={t('conversations')} actions={directory.status === 'error' && (
      <Button size="touch" onClick={() => { setRevision(current => current + 1) }}>{t('refreshConversations')}</Button>
    )}>
      {directory.status === 'loading' && <p role="status">{t('loadingConversations')}</p>}
      {directory.status === 'error' && <p role="alert">{directory.message}</p>}
      {directory.status === 'ready' && directory.entries.length === 0 && <p>{t('noSubagents')}</p>}
      {directory.status === 'ready' && directory.entries.length > 0 && <PanelTable label={t('conversations')}
        columns={[t('conversation'), t('parent')]}>
        {directory.entries.map(entry => entry.kind === 'diagnostic'
          ? <tr key={entry.id}><td colSpan={2}><p role="alert">{entry.id}: {t('conversationUnavailable')} ({entry.reason})</p></td></tr>
          : (
            <tr key={entry.id}>
              <th scope="row">
                <Button aria-label={`${t('open')}: ${nameOf(entry.id)}`}
                  onClick={() => { open(entry).then(undefined, reportError) }}>
                  <span>{nameOf(entry.id)}</span><IconRightUpOutline16 />
                </Button>
                <PanelActions>
                  <StateDot state={entry.activity === 'running' ? 'ongoing' : 'inactive'} />
                  <span className="dsw-settings-cell-desc">{t(entry.activity === 'running' ? 'memberStatus.running' : 'memberStatus.inactive')}</span>
                </PanelActions>
              </th>
              <td>{nameOf(entry.parentId)}</td>
            </tr>
          ))}
      </PanelTable>}
    </PanelSection>
  )
}
