import type { ChangeEvent, SubmitEvent } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TeamActionProps } from './TeamAction.tsx'
import css from './TeamAction.module.css'

/** Editable task fields before submission to the Team service. */
export interface TaskDraft {
  subject: string
  description: string
  blockers: string
  scopes: string
}

interface TaskFormProps {
  draft: TaskDraft
  setDraft: (draft: TaskDraft) => void
  pending: boolean
  onSave: () => void
  onCancel: () => void
  t: TeamActionProps['t']
}

/** Labeled task editor with native keyboard submission and pending-state protection. */
export function TaskForm({ draft, setDraft, pending, onSave, onCancel, t }: TaskFormProps) {
  const field = (key: keyof TaskDraft, value: string): void => { setDraft({ ...draft, [key]: value }) }
  const invalid = draft.subject.trim() === '' || draft.description.trim() === ''
  return (
    <form className={css.form} onSubmit={(event: SubmitEvent<HTMLFormElement>) => {
      event.preventDefault()
      if (!pending && !invalid) onSave()
    }}>
      <label>
        {t('subject')}
        <Input required disabled={pending} value={draft.subject} placeholder={t('subject')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('subject', event.target.value) }} />
      </label>
      <label>
        {t('description')}
        <textarea required disabled={pending} value={draft.description} placeholder={t('description')} onChange={(event: ChangeEvent<HTMLTextAreaElement>) => { field('description', event.target.value) }} />
      </label>
      <label>
        {t('blockers')}
        <Input disabled={pending} value={draft.blockers} placeholder={t('blockers')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('blockers', event.target.value) }} />
      </label>
      <label>
        {t('scopes')}
        <Input disabled={pending} value={draft.scopes} placeholder={t('scopes')} onChange={(event: ChangeEvent<HTMLInputElement>) => { field('scopes', event.target.value) }} />
      </label>
      <div className={css.formActions}>
        <Button type="submit" size="sm" disabled={pending || invalid}>{t('save')}</Button>
        <Button size="sm" disabled={pending} onClick={onCancel}>{t('cancel')}</Button>
      </div>
    </form>
  )
}
