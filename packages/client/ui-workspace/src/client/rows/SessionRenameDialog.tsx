import { useRef, useState, useTransition } from 'react'
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { WorkspaceBrowserProps } from '../contract/slots.ts'
import type { SessionNode } from '../tree.ts'
import css from './WorkspaceBrowser.module.css'

export interface SessionRenameTarget {
  sessionId: SessionNode['id']
  currentTitle: string
}

/** Edit a session title and retain a rejected draft for correction. */
export function SessionRenameDialog({ target, onClose, renameSession, t }: Pick<
  WorkspaceBrowserProps, 'renameSession' | 't'
> & {
  target: SessionRenameTarget
  onClose: () => void
}) {
  const [draft, setDraft] = useState(target.currentTitle)
  const [pending, startRename] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const composing = useRef(false)
  const title = draft.trim()
  const blocked = pending || title === ''
  const close = () => { if (!pending) onClose() }
  const confirm = () => {
    if (blocked) return
    setError(null)
    startRename(async () => {
      const result = await renameSession(target.sessionId, title)
      if (result.ok) onClose()
      else setError(result.error.message)
    })
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('rename.session.title')}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={blocked} onClick={confirm}>{t('rename')}</Button>
        </>
      )}
    >
      <input
        className={css.renameInput}
        value={draft}
        aria-label={t('field.sessionName')}
        autoFocus
        disabled={pending}
        onFocus={(event) => { event.target.select() }}
        onChange={(event) => { setDraft(event.target.value); setError(null) }}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => { composing.current = false }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !composing.current) {
            event.preventDefault()
            confirm()
          }
        }}
      />
      {error !== null && <div className={css.renameError} role="alert">{error}</div>}
    </Modal>
  )
}
