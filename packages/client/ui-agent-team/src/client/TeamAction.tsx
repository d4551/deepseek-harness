import { useCallback, useEffect, useRef, useState, type MouseEvent } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  CreateTeamTaskRequest,
  TeamMemberView as TeamRosterMember,
  TeamTaskMutationResult,
  TeamTaskView as TeamTask,
  TeamView,
  UpdateTeamTaskRequest,
} from '@deepseek-ai/dsh-agent-team/client'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  Button, Modal, Pill, IconPlusOutline16, IconRefreshOutline14, IconUserOutline16, StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS, type TeamKey } from './locales.ts'
import { observeTeamActivity } from './observe-team.ts'
import { TaskForm, type TaskDraft } from './TaskForm.tsx'
import { TaskCard } from './TaskCard.tsx'
import { TeamConversations, type TeamConversation } from './TeamConversations.tsx'

/** Generated Remote result consumed directly by the Team UI. */
export type TeamActionResult<T> = RemoteResult<T>

/** Generated Remote result whose business value preserves Team task rejections. */
export type TeamTaskActionResult = RemoteResult<TeamTaskMutationResult>

/** Business actions injected by the browser plugin. */
export interface TeamActionInjected {
  changes: (sessionId: SessionId, signal: AbortSignal) => AsyncIterable<number>
  load: (sessionId: SessionId, signal?: AbortSignal) => Promise<TeamActionResult<TeamView>>
  createTask: (sessionId: SessionId, input: CreateTeamTaskRequest) => Promise<TeamTaskActionResult>
  updateTask: (sessionId: SessionId, input: UpdateTeamTaskRequest) => Promise<TeamTaskActionResult>
  openTeammate: (sessionId: SessionId, member: TeamRosterMember) => Promise<void>
  openSubagent: (sessionId: SessionId, entry: TeamConversation) => Promise<void>
}

/** Full props of the Team conversation-header action. */
export type TeamActionProps =
  PropsRuntime<'conversation.session.header.actions'> & TeamActionInjected & PropsLocale<typeof NS>

const EMPTY_DRAFT: TaskDraft = { subject: '', description: '', blockers: '', scopes: '' }

function items(value: string): string[] {
  return [...new Set(value.split(',').map(item => item.trim()).filter(Boolean))]
}

function failureText(error: Pick<RemoteFailure, 'code' | 'message'>): string {
  return `${error.message} (${error.code})`
}

function memberStatusKey(status: TeamRosterMember['status']): TeamKey {
  switch (status) {
    case 'running': return 'memberStatus.running'
    case 'idle': return 'memberStatus.idle'
    case 'inactive': return 'memberStatus.inactive'
    case 'provisioning': return 'memberStatus.provisioning'
    case 'failed': return 'memberStatus.failed'
  }
}

/** Render the live Team roster and compare-and-set task board. */
export function TeamAction({
  sessionId, changes, load, createTask, updateTask, openTeammate, openSubagent, t,
}: TeamActionProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [view, setView] = useState<TeamView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [createDraft, setCreateDraft] = useState<TaskDraft>(EMPTY_DRAFT)
  const [editing, setEditing] = useState<TeamTask | null>(null)
  const [editDraft, setEditDraft] = useState<TaskDraft>(EMPTY_DRAFT)
  const [pendingTasks, setPendingTasks] = useState<ReadonlySet<string>>(() => new Set())
  const sessionRef = useRef(sessionId)
  const refreshGeneration = useRef(0)
  sessionRef.current = sessionId

  const reportError = (reason: unknown): string => {
    const message = String(reason)
    if (sessionRef.current === sessionId) {
      setLoading(false)
      setError(message)
    }
    return message
  }

  useEffect(() => {
    refreshGeneration.current += 1
    setOpen(false)
    setLoading(false)
    setView(null)
    setError(null)
    setCreating(false)
    setCreateDraft(EMPTY_DRAFT)
    setEditing(null)
    setEditDraft(EMPTY_DRAFT)
    setPendingTasks(new Set())
  }, [sessionId])

  const refresh = useCallback(async (signal?: AbortSignal): Promise<boolean> => {
    const requestedSession = sessionId
    const generation = ++refreshGeneration.current
    setLoading(true)
    const result = await load(requestedSession, signal)
    if (sessionRef.current !== requestedSession || refreshGeneration.current !== generation) return false
    setLoading(false)
    if (result.ok) {
      setView(result.value)
      setError(null)
      return true
    } else {
      setError(failureText(result.error))
      return false
    }
  }, [load, sessionId])

  useEffect(() => {
    if (!open) return
    const controller = new AbortController()
    const reportFailure = (reason: unknown): void => {
      if (!controller.signal.aborted) {
        setLoading(false)
        setError(String(reason))
      }
    }
    observeTeamActivity(signal => changes(sessionId, signal), refresh, controller.signal).then(
      () => {
        if (!controller.signal.aborted) {
          setLoading(false)
          setError(t('disconnected'))
        }
      },
      reportFailure,
    )
    return () => {
      controller.abort()
      refreshGeneration.current += 1
    }
  }, [changes, open, refresh, sessionId, t])

  const invalidateRefresh = useCallback((): void => {
    refreshGeneration.current += 1
    setLoading(false)
  }, [])

  const settleTask = useCallback(async (
    taskId: string,
    operation: () => Promise<TeamTaskActionResult>,
  ): Promise<TeamTask | undefined> => {
    const requestedSession = sessionId
    invalidateRefresh()
    setPendingTasks(current => new Set(current).add(taskId))
    return await Promise.try(operation).then(async (result): Promise<TeamTask | undefined> => {
      if (sessionRef.current !== requestedSession) return undefined
      if (!result.ok) {
        setError(failureText(result.error))
        return undefined
      }
      if (!result.value.ok) {
        if (result.value.error.code === 'team-task-conflict') {
          const reloaded = await refresh()
          if (sessionRef.current !== requestedSession) return undefined
          if (reloaded) setError(t('conflict'))
        } else {
          setError(failureText(result.value.error))
        }
        return undefined
      }
      const task = result.value.value
      setError(null)
      await refresh()
      if (sessionRef.current !== requestedSession) return undefined
      return task
    }).finally(() => {
      if (sessionRef.current === requestedSession) {
        setPendingTasks((current) => {
          const next = new Set(current)
          next.delete(taskId)
          return next
        })
      }
    })
  }, [invalidateRefresh, refresh, sessionId, t])

  const submitCreate = async (): Promise<boolean> => {
    const subject = createDraft.subject.trim()
    const description = createDraft.description.trim()
    const created = await settleTask('create', () => createTask(sessionId, {
      subject,
      description,
      blockedBy: items(createDraft.blockers),
      writeScopes: items(createDraft.scopes),
    }))
    if (created === undefined) return false
    setCreateDraft(EMPTY_DRAFT)
    setCreating(false)
    return true
  }

  const startEdit = (task: TeamTask): void => {
    setEditing(task)
    setEditDraft({
      subject: task.subject,
      description: task.description,
      blockers: task.blockedBy.join(', '),
      scopes: task.writeScopes.join(', '),
    })
  }

  const submitEdit = async (task: TeamTask): Promise<boolean> => {
    const requestedSession = sessionId
    const edited = await settleTask(task.id, () => updateTask(requestedSession, {
      taskId: task.id,
      expectedRevision: task.revision,
      action: 'edit',
      subject: editDraft.subject.trim(),
      description: editDraft.description.trim(),
      writeScopes: items(editDraft.scopes),
    }))
    if (edited === undefined) return false
    setEditing(edited)
    const blockedBy = items(editDraft.blockers)
    if (blockedBy.length === edited.blockedBy.length
      && blockedBy.every((blocker, index) => blocker === edited.blockedBy[index])) {
      setEditing(null)
      return true
    }
    const dependencyTask = await settleTask(task.id, () => updateTask(requestedSession, {
      taskId: task.id,
      expectedRevision: edited.revision,
      action: 'set_dependencies',
      blockedBy,
    }))
    if (dependencyTask === undefined) return false
    setEditing(null)
    return true
  }

  const conversationCount = new Set([
    ...view?.members.filter(member => member.role !== 'lead').map(member => member.id) ?? [],
    ...view?.subagents.filter(entry => entry.kind === 'child').map(entry => entry.id) ?? [],
  ]).size
  const assignable = view?.members.filter(member => member.role !== 'peer'
    && member.status !== 'failed' && member.status !== 'provisioning') ?? []
  const closePanel = (): void => {
    setOpen(false)
  }

  const togglePanel = (event: MouseEvent<HTMLButtonElement>): void => {
    event.currentTarget.focus()
    setOpen(current => !current)
  }

  return (
    <div data-team-action>
      <Button
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={togglePanel}
      >
        <IconUserOutline16 />
        <span>{t('trigger')}</span>
        {conversationCount > 0 && <Pill>{conversationCount}</Pill>}
      </Button>
      {open && (
        <Modal open={open} onClose={closePanel} title={t('trigger')} closeLabel={t('close')}>
          <div>
            <Button size="sm" aria-label={t('refresh')} onClick={() => { refresh().then(undefined, reportError) }}>
              <IconRefreshOutline14 /> {t('refresh')}
            </Button>
          </div>
          {error !== null && <div role="alert">{error}</div>}
          {loading && <p role="status">{t('loading')}</p>}
          {view !== null && (
            <>
              <section>
                <h3>{t('roster')}</h3>
                <div>
                  {view.members.map(member => (
                    <article key={member.id}>
                      <div>
                        <StateDot state={member.status === 'running' ? 'ongoing' : member.status === 'failed' ? 'error' : 'inactive'} />
                        <Button
                          disabled={member.id === sessionId || member.status === 'failed' || member.status === 'provisioning'}
                          title={t('open')}
                          onClick={() => {
                            openTeammate(sessionId, member).then(undefined, reportError)
                          }}
                        >{member.name}</Button>
                      </div>
                      <p>{t(memberStatusKey(member.status))}{member.model === undefined ? '' : ` · ${t('model')}: ${member.model}`}</p>
                      {member.diagnostics.map(diagnostic => <p key={diagnostic}>{diagnostic}</p>)}
                    </article>
                  ))}
                </div>
              </section>
              <section>
                <div>
                  <h3>{t('tasks')}</h3>
                  <Button size="sm" disabled={creating} onClick={() => { setCreating(true) }}>
                    <IconPlusOutline16 /> {t('create')}
                  </Button>
                </div>
                {creating && (
                  <TaskForm
                    draft={createDraft}
                    setDraft={setCreateDraft}
                    pending={pendingTasks.has('create')}
                    onSave={() => { submitCreate().then(undefined, reportError) }}
                    onCancel={() => { setCreating(false) }}
                    t={t}
                  />
                )}
                {view.tasks.length === 0 && !creating && <p>{t('empty')}</p>}
                <div>
                  {view.tasks.map(task => editing?.id === task.id
                    ? (
                      <TaskForm
                        key={task.id}
                        draft={editDraft}
                        setDraft={setEditDraft}
                        pending={pendingTasks.has(task.id)}
                        onSave={() => { submitEdit(editing).then(undefined, reportError) }}
                        onCancel={() => { setEditing(null) }}
                        t={t}
                      />
                    )
                    : (
                      <TaskCard
                        key={task.id} task={task} members={assignable} pending={pendingTasks.has(task.id)}
                        edit={() => { startEdit(task) }} t={t}
                        update={(input) => {
                          settleTask(task.id, () => updateTask(sessionId, input)).then(undefined, reportError)
                        }}
                      />
                    ))}
                </div>
              </section>
              <TeamConversations
                view={view} t={t} open={entry => openSubagent(sessionId, entry)}
                reportError={reportError}
              />
            </>
          )}
        </Modal>
      )}
    </div>
  )
}
