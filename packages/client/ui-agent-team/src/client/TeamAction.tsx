import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { TeamMemberView, TeamOverview, TeamView } from '@deepseek-ai/dsh-agent-team/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  Button, Modal, PanelLayout, PanelStack,
  IconRefreshOutline14, IconUserOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import { observeTeamActivity } from './observe-team.ts'
import { TeamTasks } from './TeamTasks.tsx'
import { TeamMembers } from './TeamMembers.tsx'
import { TeamConversations, type TeamConversation } from './TeamConversations.tsx'
import { TeamMessages } from './TeamMessages.tsx'

/** Values a Promise reject arm or wire refusal may deliver. */
export type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

/**
 * Human text for a rejected team load, refresh, or navigation.
 * @param reason - the Thrown the transport or host rejected with.
 * @returns the message to show.
 */
export function thrownMessage(reason: Thrown): string {
  if (reason instanceof Error) return reason.message
  switch (typeof reason) {
    case 'string': return reason
    case 'number':
    case 'boolean':
    case 'bigint':
    case 'symbol':
    case 'function':
      return String(reason)
    case 'undefined':
      return 'undefined'
    case 'object':
      if (reason === null) return 'null'
      return Object.prototype.toString.call(reason)
  }
}

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

function useTeamObservation({ sessionId, changes, load, t }: Pick<TeamActionProps, 'sessionId' | 'changes' | 'load' | 't'>) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<TeamOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const sessionRef = useRef(sessionId)
  const refreshGeneration = useRef(0)
  sessionRef.current = sessionId
  const reportError = (reason: Thrown): void => {
    if (sessionRef.current === sessionId) {
      setLoading(false)
      setError(thrownMessage(reason))
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
    const opened = await load(sessionId, signal).then(
      result => result,
      (reason: Thrown) => {
        if (sessionRef.current !== sessionId || refreshGeneration.current !== generation) return
        setLoading(false)
        setError(thrownMessage(reason))
      },
    )
    if (sessionRef.current !== sessionId || refreshGeneration.current !== generation) return false
    if (opened === undefined) return false
    setLoading(false)
    if (opened.ok) {
      setView(opened.value)
      setError(null)
      return true
    }
    setError(`${opened.error.message} (${opened.error.code})`)
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
      (reason: Thrown) => {
        if (!controller.signal.aborted) {
          setLoading(false)
          setError(thrownMessage(reason))
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
  const togglePanel = (event: MouseEvent<HTMLButtonElement>): void => {
    event.currentTarget.focus()
    setOpen(current => !current)
  }
  return (
    <div data-team-action>
      <Button size="sm" aria-haspopup="dialog" aria-expanded={open} onClick={togglePanel}>
        <IconUserOutline16 /><span>{t('trigger')}</span>
      </Button>
      {open && <Modal open onClose={() => { setOpen(false) }} title={t('trigger')} description={t('overview')}
        closeLabel={t('close')} size="workspace" headerActions={(
          <Button size="touch" aria-label={t('refresh')} aria-busy={loading} onClick={() => { refresh().then(undefined, reportError) }}>
            <IconRefreshOutline14 />
          </Button>
        )}>
        {error !== null && <p role="alert">{error}</p>}
        {loading && view === null && <output>{t('loading')}</output>}
        {view !== null && <PanelLayout>
          <PanelStack>
            <TeamMembers members={view.members} sessionId={sessionId} t={t}
              open={member => openTeammate(sessionId, member)} reportError={reportError} />
            <TeamConversations view={view} t={t} open={entry => openSubagent(sessionId, entry)}
              reportError={reportError} load={loadDirectory} />
          </PanelStack>
          <PanelStack>
            <TeamTasks view={view} t={t} />
            <TeamMessages view={view} t={t} />
          </PanelStack>
        </PanelLayout>}
      </Modal>}
    </div>
  )
}
