/**
 * Official popupSelect shell: renders one session's PopupSelectController
 * store into the conversation.input.overlay anchor. Unlike the slash menu
 * (combobox — textarea keeps focus), this shell HOLDS focus while open: the
 * inner search input takes focus, plain typing filters the loaded options
 * locally, Enter/↑↓ drive the filtered highlight (scrolled into view), Escape
 * dismisses back to the composer, and ←→ keep the search input's native
 * caret. Any pointer interaction outside the box dismisses (the click's own
 * target takes focus). Closed state renders null; the overlay slot stays
 * mounted. The card height clamps to the space above the composer.
 *
 * Ready options render in a native `<select size>` listbox with
 * `appearance: base-select` so rows keep implicit option semantics while
 * still hosting label, detail, and the current-value check.
 */
import { startTransition, useEffect, useRef } from 'react'
import { useSyncExternalStore } from 'react'
import clsx from 'clsx'
import { IconCheckOutline16, RiskConfirmation, useAnchoredMaxHeight } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { filterOptions } from './popup.ts'
import type { PopupSelectController } from './popup.ts'
import css from './PopupSelectView.module.css'

/** Design cap on the card height (same MenuDropdown family as the slash menu). */
const MAX_HEIGHT = 320

/** Injected business face of the popupSelect overlay entry. */
export interface PopupSelectInjected {
  /** The session's shell controller (state store + verbs; the view never touches the open-context type). */
  popup: PopupSelectController
}

/** Full shell props: injected face + the locale seat. */
export type PopupSelectViewProps = PopupSelectInjected & PropsLocale<'command'>

/**
 * Render the popupSelect shell overlay entry.
 * @param props - injected face: the session's shell controller; `t` rides the standard locale seat.
 * @returns the select card while open; null while closed.
 */
export function PopupSelectView({ popup, t }: PopupSelectViewProps) {
  const state = useSyncExternalStore(
    fn => popup.state.subscribe(fn),
    () => popup.state.getSnapshot(),
  )
  const cardRef = useRef<HTMLDialogElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  // The card is bottom-anchored above the composer; clamp the design cap to
  // the space above it, re-measured on every store update.
  const maxHeight = useAnchoredMaxHeight(cardRef, MAX_HEIGHT, state)
  const active = state.open ? state.active : null

  // The search input keeps focus while arrows move a virtual highlight, so
  // the browser never scrolls the active row into view — do it here.
  useEffect(() => {
    if (active === null) return
    cardRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Focus ownership: the search input grabs on open, and ANY outside
  // pointer interaction dismisses —
  // capture phase so a click landing anywhere else (textarea included)
  // closes the shell before its own handlers run; that click's target then
  // takes focus naturally, so no focusComposer here.
  useEffect(() => {
    if (!state.open || state.confirming !== null) return
    const onPointerDown = (ev: PointerEvent): void => {
      if (cardRef.current !== null && ev.target instanceof Node && cardRef.current.contains(ev.target)) return
      popup.dismiss()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => { document.removeEventListener('pointerdown', onPointerDown, true) }
  }, [state.open, state.confirming, popup])

  // Focus the search input after it mounts (separate effect so the ref is populated).
  useEffect(() => {
    if (state.open && state.confirming === null) searchRef.current?.focus()
  }, [state.open, state.confirming])

  if (!state.open) return null

  const rows = filterOptions(state.options, state.search)
  const confirmation = state.confirming?.confirmation

  const onKeyDown = (ev: React.KeyboardEvent<HTMLDialogElement>): void => {
    // ArrowLeft/ArrowRight fall through on purpose: the search input keeps
    // its native caret movement.
    switch (ev.key) {
      case 'ArrowDown':
        ev.preventDefault()
        popup.move(1)
        return
      case 'ArrowUp':
        ev.preventDefault()
        popup.move(-1)
        return
      case 'Enter':
        ev.preventDefault()
        startTransition(() => popup.select(state.active))
        return
      case 'Escape':
        ev.preventDefault()
        popup.dismiss({ focusComposer: true })
        return
      default:
    }
  }

  return (
    <>
      {state.confirming === null && (
        <dialog
          ref={cardRef}
          className={css.card}
          open
          style={{ maxHeight }}
          aria-label={t('overlay.aria', { command: String(state.command) })}
          onKeyDown={onKeyDown}
        >
          <input
            ref={searchRef}
            className={css.search}
            type="text"
            placeholder={t('search.placeholder')}
            aria-label={t('search.aria')}
            value={state.search}
            readOnly={state.submitting}
            onChange={(ev) => { popup.setSearch(ev.currentTarget.value) }}
          />
          {state.error !== null && (
            <div className={css.error} role="alert">
              <span className={css.errorText}>{state.error}</span>
              {state.status === 'failed' && (
                <button type="button" className={css.retry} onClick={() => { popup.retry() }}>{t('retry')}</button>
              )}
            </div>
          )}
          {state.status === 'pending' && <div className={css.status}>{t('status.loading')}</div>}
          {state.submitting && <div className={css.status}>{t('status.applying')}</div>}
          {state.status === 'ready' && rows.length === 0 && <div className={css.status}>{t('status.empty')}</div>}
          {state.status === 'ready' && rows.length > 0 && (
            <select
              className={css.viewport}
              size={Math.max(2, rows.length)}
              tabIndex={-1}
              aria-label={t('listbox.aria', { command: String(state.command) })}
              value={rows[state.active]?.id ?? rows[0]?.id ?? ''}
              onMouseDown={(ev) => { ev.preventDefault() }}
              onChange={(ev) => {
                const value = ev.currentTarget.value
                if (value === '') return
                const selected = rows.findIndex(option => option.id === value)
                if (selected < 0) throw new Error(`popup option ${value} is missing`)
                popup.highlight(selected)
              }}
            >
              {rows.map((option, index) => (
                <option
                  key={option.id}
                  value={option.id}
                  aria-selected={index === state.active}
                  className={clsx(css.row, index === state.active && css.rowActive)}
                  onClick={() => { startTransition(() => popup.select(index)) }}
                  onMouseEnter={() => { popup.highlight(index) }}
                >
                  <span className={css.label}>{option.label}</span>
                  {option.detail !== undefined && <span className={css.detail}>{option.detail}</span>}
                  {option.active === true && <span className={css.check}><IconCheckOutline16 /></span>}
                </option>
              ))}
            </select>
          )}
        </dialog>
      )}
      {confirmation !== undefined && (
        <RiskConfirmation
          open
          title={confirmation.title}
          description={confirmation.description}
          acknowledgeLabel={confirmation.acknowledgeLabel}
          cancelLabel={confirmation.cancelLabel}
          closeLabel={t('close')}
          confirmLabel={confirmation.confirmLabel}
          acknowledged={state.acknowledged}
          onAcknowledgedChange={(value) => { popup.acknowledge(value) }}
          onCancel={() => { popup.cancelConfirmation() }}
          onConfirm={() => { startTransition(() => popup.confirm()) }}
        />
      )}
    </>
  )
}
