import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamMemberView, TeamOverview, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  Button, Modal, Pill, PanelLayout, PanelStack, PanelSection, PanelEntry, PanelActions,
  IconRefreshOutline14, IconUserOutline16, IconRightUpOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import { observeTeamActivity } from './observe-team.ts'
import { TaskCard } from './TaskCard.tsx'
import { TeamConversations, type TeamConversation } from './TeamConversations.tsx'
import { TeamMessages } from './TeamMessages.tsx'
import { memberLabel } from './member-label.ts'

/** Generated Remote result consumed directly by the Team UI. */
export type TeamActionResult<T> = RemoteResult<T>

/** Live workspace observations and conversation navigation. */
export interface TeamActionInjected {
  changes: (sessionId: SessionId, signal: AbortSignal) => AsyncIterable<number>
  load: (sessionId: SessionId, signal?: AbortSignal) => Promise<TeamActionResult<TeamOverview>>
  loadConversations: (sessionId: SessionId, signal: AbortSignal) => Promise<TeamActionResult<TeamView['subagents']>>
  openTeammate: (sessionId: SessionId, member: TeamMemberView) => Promise<void>
  openSubagent: (sessionId: SessionId, entry: TeamConversation) => Promise<void>
}

/** Full props of the Team conversation-header action. */
export type TeamActionProps = PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

function memberStatusKey(status: TeamMemberView['status']): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'idle': return 'memberStatus.idle'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

function useTeamObservation({ sessionId, changes, load, t }: Pick<TeamActionProps, 'sessionId' | 'changes' | 'load' | 't'>) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<TeamOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef(sessionId)
  const refreshGeneration = useRef(0)
  sessionRef.current = sessionId
  const reportError = (reason: unknown): void => {
    if (sessionRef.current === sessionId) {
      setLoading(false)
      setError(String(reason))
    }
  }

  useEffect(() => {
    refreshGeneration.current += 1
    setOpen(false)
    setLoading(false)
    setView(null)
    setError(null)
  }, [sessionId])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const generation = ++refreshGeneration.current
    setLoading(true)
    const result = await load(sessionId, signal)
    if (sessionRef.current !== sessionId || refreshGeneration.current !== generation) return false
    setLoading(false)
    if (result.ok) {
      setView(result.value)
      setError(null)
      return true
    }
    setError(`${result.error.message} (${result.error.code})`)
    return false
  }, [load, sessionId])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    observeTeamActivity(signal => changes(sessionId, signal), refresh, controller.signal).then(
      () => {
        if (!controller.signal.aborted) {
          setLoading(false)
          setError(t('disconnected'))
        }
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) {
          setLoading(false)
          setError(String(reason))
        }
      },
    )
    return () => { controller.abort(); refreshGeneration.current += 1 }
  }, [changes, open, refresh, sessionId, t])
  return { open, setOpen, loading, view, error, refresh, reportError }
}

/** Observe agent-owned work, messages, and conversation activity. */
export function TeamAction({ sessionId, changes, load, loadConversations, openTeammate, openSubagent, t }: TeamActionProps) {
  const { open, setOpen, loading, view, error, refresh, reportError } = useTeamObservation({ sessionId, changes, load, t })
  const loadDirectory = useCallback((signal: AbortSignal) => loadConversations(sessionId, signal), [loadConversations, sessionId])
  const conversationCount = view?.members.filter(member => member.role !== 'lead').length ?? 0
  const togglePanel = (event: MouseEvent<HTMLButtonElement>): void => {
    event.currentTarget.focus()
    setOpen(current => !current)
  }
  return (
    <div data-team-action>
      <Button type="button" aria-haspopup="dialog" aria-expanded={open} onClick={togglePanel}>
        <IconUserOutline16 /><span>{t('trigger')}</span>
        {conversationCount > 0 && <Pill>{conversationCount}</Pill>}
      </Button>
      {open && <Modal open onClose={() => { setOpen(false) }} title={t('trigger')} description={t('overview')}
        closeLabel={t('close')} size="workspace" headerActions={(
          <Button size="touch" aria-label={t('refresh')} aria-busy={loading} onClick={() => { refresh().then(undefined, reportError) }}>
            <IconRefreshOutline14 />
          </Button>
        )}>
        {error !== null && <p role="alert">{error}</p>}
        {loading && view === null && <p role="status">{t('loading')}</p>}
        {view !== null && <PanelLayout>
          <PanelStack>
            <TeamMessages view={view} t={t} />
            <PanelSection title={t('roster')} actions={<Pill>{view.members.length}</Pill>}>
              {view.members.map(member => <PanelEntry key={member.id} actions={
                member.id !== sessionId && member.status !== 'failed' && member.status !== 'provisioning'
                  ? <Button size="touch" title={t('open')} aria-label={`${t('open')}: ${memberLabel(member, t)}`}
                    onClick={() => { openTeammate(sessionId, member).then(undefined, reportError) }}
                  ><IconRightUpOutline16 /></Button> : undefined
              }>
                <PanelActions>
                  <StateDot state={member.status === 'running' ? 'ongoing' : member.status === 'failed' ? 'error' : 'inactive'} />
                  <span className="dsw-settings-cell-title" title={member.name}>
                    {memberLabel(member, t)}
                  </span>
                  <span className="dsw-settings-cell-desc">{t(memberStatusKey(member.status))}</span>
                </PanelActions>
                {member.description !== undefined && <p className="dsw-settings-cell-desc">{member.description}</p>}
                {member.model !== undefined && <p className="dsw-settings-cell-desc">{t('model')}: {member.model}</p>}
                {member.diagnostics.map(diagnostic => <p key={diagnostic}>{diagnostic}</p>)}
              </PanelEntry>)}
            </PanelSection>
            <TeamConversations view={view} t={t} open={entry => openSubagent(sessionId, entry)}
              reportError={reportError} load={loadDirectory} />
          </PanelStack>
          <PanelSection title={t('tasks')} description={t('tasksDescription')}>
            {view.tasks.length === 0 && view.workspaceTasks.every(board => board.tasks.length === 0) && <p>{t('empty')}</p>}
            {view.tasks.map(task => <TaskCard key={task.id} task={task} t={t} />)}
            {view.workspaceTasks.map(board => board.tasks.length > 0 && <PanelEntry key={board.sessionId}>
              <span className="dsw-settings-cell-title">{memberLabel(view.members.find(member => member.id === board.sessionId), t)}</span>
              {board.tasks.map(task => <TaskCard key={task.id} task={task} t={t} />)}
            </PanelEntry>)}
          </PanelSection>
        </PanelLayout>}
      </Modal>}
    </div>
  )
}
