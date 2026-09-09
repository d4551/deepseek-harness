import { useId, type ChangeEvent } from 'react'
import type { TeamMemberView, TeamTaskView, UpdateTeamTaskRequest } from '@deepseek-ai/dsh-agent-team/client'
import {
  Button, Pill, Select, SettingsFields, PanelEntry, PanelActions, IconCheckOutline14, IconEditOutline16, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'

interface TaskCardProps {
  task: TeamTaskView
  members: TeamMemberView[]
  pending: boolean
  edit: () => void
  update: (input: UpdateTeamTaskRequest) => void
  t: (key: TeamKey) => string
}

function statusKey(status: TeamTaskView['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    case 'deleted': return 'status.deleted'
  }
}

/** One task's status, ownership, dependencies, and revision-bound controls. */
export function TaskCard({ task, members, pending, edit, update, t }: TaskCardProps) {
  const ownerId = useId()
  const transition = (action: UpdateTeamTaskRequest['action']): void => {
    update({ taskId: task.id, expectedRevision: task.revision, action })
  }
  return (
    <PanelEntry aria-label={task.subject} aria-busy={pending}>
      <SettingsFields title={task.subject} description={task.description}>
        <Pill>{t(statusKey(task.status))}</Pill>
        <ul>
          <li>{task.id}</li>
          {task.status === 'pending' && <li>{task.ready ? t('ready') : t('blocked')}</li>}
          {task.blockedBy.length > 0 && <li>{t('blockedBy')}: {task.blockedBy.join(', ')}</li>}
          {task.writeScopes.length > 0 && <li>{t('writeScopes')}: {task.writeScopes.join(', ')}</li>}
          {task.writeScopeWarnings.map(warning => <li key={warning}>{warning}</li>)}
        </ul>
        <PanelActions>
          <label htmlFor={ownerId}>{t('owner')}</label>
          <Select
            id={ownerId}
            value={task.ownerName ?? ''}
            disabled={pending || task.status === 'completed'}
            onChange={(event: ChangeEvent<HTMLSelectElement>) => {
              const owner = event.target.value
              update({
                taskId: task.id,
                expectedRevision: task.revision,
                action: 'reassign',
                ...owner === '' ? {} : { owner },
              })
            }}
          >
            <option value="">{t('unowned')}</option>
            {task.ownerName !== undefined && !members.some(member => member.name === task.ownerName) && (
              <option value={task.ownerName} disabled>{task.ownerName}</option>
            )}
            {members.map(member => <option key={member.id} value={member.name}>{member.name}</option>)}
          </Select>
        </PanelActions>
        <PanelActions>
          <Button size="sm" onClick={edit} disabled={pending}>
            <IconEditOutline16 /> {t('edit')}
          </Button>
          {task.status === 'in_progress' && (
            <Button size="sm" disabled={pending} onClick={() => { transition('complete') }}>
              <IconCheckOutline14 /> {t('complete')}
            </Button>
          )}
          {task.status === 'completed' && (
            <Button size="sm" disabled={pending} onClick={() => { transition('reopen') }}>{t('reopen')}</Button>
          )}
          <Button size="sm" disabled={pending} onClick={() => { transition('delete') }}>
            <IconTrashOutline16 /> {t('delete')}
          </Button>
        </PanelActions>
      </SettingsFields>
    </PanelEntry>
  )
}
