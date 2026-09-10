import type { TeamTaskView } from '@deepseek-ai/dsh-agent-team/client'
import { Pill, PanelEntry, PanelActions } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'

function statusKey(status: TeamTaskView['status']): TeamKey {
  switch (status) {
    case 'pending': return 'status.pending'
    case 'in_progress': return 'status.in_progress'
    case 'completed': return 'status.completed'
    case 'deleted': return 'status.deleted'
  }
}

/** Current agent-owned task state from the durable workspace board. */
export function TaskCard({ task, t }: { task: TeamTaskView; t: (key: TeamKey) => string }) {
  return <PanelEntry aria-label={task.subject}>
    <strong>{task.subject}</strong>
    <p>{task.description}</p>
    <PanelActions>
      <Pill>{t(statusKey(task.status))}</Pill>
      <Pill>{task.id}</Pill>
      {task.status === 'pending' && <Pill>{task.ready ? t('ready') : t('blocked')}</Pill>}
    </PanelActions>
    <p>{t('owner')}: {task.ownerName ?? t('unowned')}</p>
    {task.blockedBy.length > 0 && <p>{t('blockedBy')}: {task.blockedBy.join(', ')}</p>}
    {task.writeScopes.length > 0 && <p>{t('writeScopes')}: {task.writeScopes.join(', ')}</p>}
    {task.writeScopeWarnings.map(warning => <p key={warning}>{warning}</p>)}
  </PanelEntry>
}
