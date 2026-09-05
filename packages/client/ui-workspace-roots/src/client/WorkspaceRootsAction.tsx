import { useCallback, useEffect, useId, useRef, useState } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionWorkspaceOrigin } from '@deepseek-ai/dsh-api-session-controller/types'
import type { RemoteFailure, RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  IconBrowseOutline16, IconCloseOutline16, IconFolderOpenOutline16, IconPlusOutline16,
  IconRefreshOutline14, IconTrashOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: pulls the `workspaceRoots` SessionProjectionMap merge useProjection reads.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import { NS, type WorkspaceRootsKey } from './locales.ts'
import css from './WorkspaceRootsAction.module.css'

/** Business actions injected by the browser plugin. */
export interface WorkspaceRootsInjected {
  /**
   * Replace the Session's complete additional-root set.
   * @param sessionId - Session whose roots change.
   * @param additionalDirectories - complete replacement set of absolute roots.
   * @returns the Remote result; the projection, not this value, drives the list.
   */
  setRoots: (
    sessionId: SessionId,
    additionalDirectories: readonly string[],
  ) => Promise<RemoteResult<{ readonly additional: readonly string[] }>>
  /**
   * Open the host's directory chooser.
   * @returns the chosen absolute path, or null when the operator cancels.
   */
  pickDirectory: () => Promise<string | null>
  /**
   * Read where this deployment's filesystem backend keeps the workspace.
   * @returns the Remote result; a null value states the deployment composes no backend.
   */
  loadOrigin: () => Promise<RemoteResult<SessionWorkspaceOrigin | null>>
}

/** Full props of the workspace-root conversation-header action. */
export type WorkspaceRootsActionProps =
  PropsRuntime<'conversation.session.header.actions'>
  & WorkspaceRootsInjected
  & PropsLocale<typeof NS>

/**
 * Remote failure text. Failure strings stay English by the client error-surface
 * policy; only this package's own copy is localized.
 * @param error - the Remote failure.
 * @returns the message plus its stable code.
 */
function failureText(error: Pick<RemoteFailure, 'code' | 'message'>): string {
  return `${error.message} (${error.code})`
}

/**
 * Whether a typed path is one the host will accept. The host rejects a
 * relative root before it touches the durable record; checking the same rule
 * here answers in the field the person is typing in, and the host stays the
 * enforcement point either way.
 * @param path - the trimmed path a person typed or chose.
 * @returns true for a POSIX or Windows absolute path.
 */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')
}

/**
 * Localized name of one filesystem origin. The origin vocabulary is
 * merge-extensible, so an unknown member falls through to a form that names
 * the raw kind instead of claiming one this dictionary knows.
 * @param kind - the origin the deployment reported.
 * @param t - the namespace translator.
 * @returns the label to show beside the primary root.
 */
export function originLabel(kind: string, t: TranslateNS<typeof NS>): string {
  const key = `origin.${kind}` as WorkspaceRootsKey
  return key === 'origin.local' || key === 'origin.network-drive' ? t(key) : t('origin.other', { kind })
}

/**
 * Session-header entry point for the folders this session works in: the
 * primary root with its filesystem origin, every additional root the session
 * recorded, and the add/remove controls over the Session Remote.
 *
 * The list is the host `workspaceRoots` projection, never client state: a
 * mutation is a request, and the row set changes when the resulting
 * `workspace/roots` event folds back through the projection. That is why a
 * failed mutation leaves the rendered set untouched.
 * @param props - runtime slot currency, injected actions, and the translator.
 * @returns the trigger and its panel, or the loading placeholder before the projection arrives.
 */
export function WorkspaceRootsAction({
  sessionId, useProjection, setRoots, pickDirectory, loadOrigin, t,
}: WorkspaceRootsActionProps) {
  const roots = useProjection('workspaceRoots')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [fieldError, setFieldError] = useState(false)
  const [retry, setRetry] = useState<(() => void) | null>(null)
  const [saving, setSaving] = useState(false)
  const [origin, setOrigin] = useState<SessionWorkspaceOrigin | null | undefined>(undefined)
  const aliveRef = useRef(true)
  const sessionRef = useRef(sessionId)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const errorId = useId()
  sessionRef.current = sessionId

  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
    }
  }, [])

  // A different session is a different root set: drop every control state that
  // described the previous one rather than carrying it onto the new rows.
  useEffect(() => {
    setOpen(false)
    setDraft('')
    setError(null)
    setFieldError(false)
    setRetry(null)
    setSaving(false)
  }, [sessionId])

  useEffect(() => {
    if (open) closeRef.current?.focus()
  }, [open])

  // The origin is a deployment constant, so one read serves every session this
  // component sees. It is read when the panel first opens, not at mount, so a
  // conversation nobody opens the panel on costs no request.
  useEffect(() => {
    if (!open || origin !== undefined) return
    void loadOrigin().then((result) => {
      if (!aliveRef.current) return
      setOrigin(result.ok ? result.value : null)
    }, () => {
      if (aliveRef.current) setOrigin(null)
    })
  }, [loadOrigin, open, origin])

  const submit = useCallback((next: readonly string[], after: () => void): void => {
    setSaving(true)
    setError(null)
    setFieldError(false)
    setRetry(null)
    void setRoots(sessionId, next).then((result) => {
      if (!aliveRef.current || sessionRef.current !== sessionId) return
      setSaving(false)
      if (result.ok) {
        after()
        return
      }
      setError(failureText(result.error))
      setFieldError(false)
      setRetry(() => () => { submit(next, after) })
    }, (reason: unknown) => {
      if (!aliveRef.current || sessionRef.current !== sessionId) return
      setSaving(false)
      setError(reason instanceof Error ? reason.message : String(reason))
      setFieldError(false)
      setRetry(() => () => { submit(next, after) })
    })
  }, [sessionId, setRoots])

  if (roots === undefined) {
    return <span className={css.skeleton} role="status" aria-label={t('trigger.loading')} />
  }

  const additional = roots.additional
  const count = additional.length + (roots.primary === null ? 0 : 1)

  const add = (): void => {
    const path = draft.trim()
    if (path === '') return
    if (!isAbsolutePath(path)) {
      setError(t('add.relative'))
      setFieldError(true)
      setRetry(null)
      return
    }
    if (path === roots.primary || additional.includes(path)) {
      setError(t('add.duplicate'))
      setFieldError(true)
      setRetry(null)
      return
    }
    submit([...additional, path], () => { setDraft('') })
  }

  const browse = (): void => {
    setError(null)
    setFieldError(false)
    void pickDirectory().then((chosen) => {
      if (!aliveRef.current || sessionRef.current !== sessionId || chosen === null) return
      setDraft(chosen)
    }, (reason: unknown) => {
      if (aliveRef.current && sessionRef.current === sessionId) {
        setError(reason instanceof Error ? reason.message : String(reason))
        setFieldError(false)
      }
    })
  }

  return (
    <div className={css.root}>
      <button
        ref={triggerRef}
        type="button"
        className={css.trigger}
        aria-expanded={open}
        aria-label={t('trigger.aria', { count })}
        onClick={() => { setOpen(current => !current) }}
      >
        <IconFolderOpenOutline16 size={14} />
        <span>{t('trigger')}</span>
        <span className={css.count}>{count}</span>
      </button>
      {open && (
        <div
          className={css.panel}
          role="dialog"
          aria-labelledby={titleId}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.stopPropagation()
            setOpen(false)
            triggerRef.current?.focus()
          }}
        >
          <div className={css.toolbar}>
            <strong id={titleId}>{t('title')}</strong>
            <span className={css.spacer} />
            <button
              ref={closeRef}
              type="button"
              className={css.iconButton}
              aria-label={t('close')}
              onClick={() => {
                setOpen(false)
                triggerRef.current?.focus()
              }}
            >
              <IconCloseOutline16 size={14} />
            </button>
          </div>
          {error !== null && (
            <div className={css.alert} role="alert" id={errorId}>
              <span className={css.alertText}>{error}</span>
              {retry !== null && (
                <button type="button" className={css.retry} onClick={retry} disabled={saving}>
                  <IconRefreshOutline14 />
                  <span>{t('retry')}</span>
                </button>
              )}
            </div>
          )}
          <ul className={css.list} aria-label={t('list.aria')}>
            {roots.primary !== null && (
              <li className={css.row}>
                <span className={css.path}>{roots.primary}</span>
                <span className={css.badge}>{t('primary')}</span>
                {origin !== undefined && origin !== null && (
                  <span className={css.badge} aria-label={t('origin.aria', { origin: originLabel(origin.kind, t) })}>
                    {originLabel(origin.kind, t)}
                  </span>
                )}
              </li>
            )}
            {additional.map(root => (
              <li key={root} className={css.row}>
                <span className={css.path}>{root}</span>
                <button
                  type="button"
                  className={css.iconButton}
                  aria-label={t('remove.aria', { path: root })}
                  disabled={saving}
                  onClick={() => { submit(additional.filter(entry => entry !== root), () => {}) }}
                >
                  <IconTrashOutline16 size={14} />
                </button>
              </li>
            ))}
          </ul>
          {additional.length === 0 && (
            <div className={css.empty}>
              <IconFolderOpenOutline16 className={css.emptyIcon} />
              <strong>{t('empty.title')}</strong>
              <p>{t('empty.description')}</p>
            </div>
          )}
          <form className={css.form} onSubmit={(event) => { event.preventDefault(); add() }}>
            <label className={css.field}>
              <span className={css.fieldLabel}>{t('add.label')}</span>
              <input
                className={css.input}
                value={draft}
                placeholder={t('add.placeholder')}
                disabled={saving}
                aria-invalid={fieldError || undefined}
                aria-describedby={fieldError ? errorId : undefined}
                onChange={(event) => {
                  setDraft(event.target.value)
                  setError(null)
                  setFieldError(false)
                }}
              />
            </label>
            <div className={css.formActions}>
              <button type="button" className={css.action} disabled={saving} onClick={browse}>
                <IconBrowseOutline16 size={14} />
                <span>{t('add.browse')}</span>
              </button>
              <button type="submit" className={css.action} disabled={saving || draft.trim() === ''}>
                <IconPlusOutline16 size={14} />
                <span>{saving ? t('saving') : t('add.submit')}</span>
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  )
}
