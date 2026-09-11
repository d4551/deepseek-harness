import type { TeamOverview } from '@deepseek-ai/dsh-agent-team/client'
import { PanelSection, PanelEntry, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamKey } from './locales.ts'
import { memberLabel } from './member-label.ts'
import { TaskCard } from './TaskCard.tsx'

/** Live task boards retain their owning conversation and committed state. */
export function TeamTasks({ view, t }: { view: TeamOverview; t: (key: TeamKey) => string }) {
  const count = view.tasks.length + view.workspaceTasks.reduce((total, board) => total + board.tasks.length, 0)
  return <PanelSection title={t('tasks')} description={t('tasksDescription')} actions={<Pill>{count}</Pill>}>
    {view.tasks.length === 0 && <p>{t('empty')}</p>}
    {view.tasks.map(task => <TaskCard key={task.id} task={task} t={t} />)}
    {view.workspaceTasks.map(board => board.tasks.length > 0 && <PanelEntry key={board.sessionId}>
      <span className="dsw-settings-cell-title">{memberLabel(view.members.find(member => member.id === board.sessionId), t)}</span>
      {board.tasks.map(task => <TaskCard key={task.id} task={task} t={t} />)}
    </PanelEntry>)}
  </PanelSection>
}
