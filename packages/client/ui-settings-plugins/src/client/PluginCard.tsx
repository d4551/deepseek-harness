/**
 * One plugin's card: a header naming the plugin and what its settings govern,
 * disclosing that plugin's controls in place, with the save that writes them.
 *
 * Staged edits outlive collapsing; the header marks unsaved edits. Successful
 * saves collapse the form and return its keyboard focus to the header.
 *
 * A card renders nothing while its namespace is unavailable: a deployment that
 * does not compose the owning plugin should show no trace of it, rather than a
 * disabled card the user cannot act on.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Button, DisclosureRow, Pill, IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { CardShell } from './card-form.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'

/** Card chrome shared by every plugin section. */
export interface PluginCardProps {
  /** Locale reader for this section's copy. */
  t: (key: PluginsSettingsLocaleKey) => string
  /** Locale key of the plugin's name. */
  titleKey: PluginsSettingsLocaleKey
  /** Locale key of the line describing what this plugin's settings govern. */
  descriptionKey: PluginsSettingsLocaleKey
  /** The card's form state: availability, writability, and what a save would do. */
  state: CardShell
  /** Persist action; a caller may return the settlement of the underlying write. */
  onSave: () => unknown
  /** Drop every staged edit. */
  onDiscard: () => void
  /** The plugin's controls. */
  children: ReactNode
}

/**
 * Render one plugin card.
 * @param props - the plugin's copy keys, its form state, and its controls.
 * @returns the card, or nothing when the namespace is unavailable.
 */
export function PluginCard(props: PluginCardProps) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const saveStarted = useRef(false)
  const saveHadFocus = useRef(false)
  const { state } = props
  // Collapse only after Host-confirmed settlement; a rejected write keeps its
  // diagnostics and retained drafts visible for correction.
  useEffect(() => {
    if (state.saving) {
      saveStarted.current = true
      return
    }
    if (!saveStarted.current) return
    saveStarted.current = false
    if (!state.dirty && !state.failed) {
      const active = document.activeElement
      if (bodyRef.current?.contains(active) || (saveHadFocus.current && active === document.body)) {
        rootRef.current?.querySelector<HTMLElement>('[data-disclosure-row]')?.focus()
      }
      setOpen(false)
    }
    saveHadFocus.current = false
  }, [state.dirty, state.failed, state.saving])
  if (!state.available) return null
  const title = props.t(props.titleKey)
  const blocked = !state.writable || !state.dirty || state.invalid || state.saving
  return (
    <div role="listitem" ref={rootRef}>
      <DisclosureRow
        title={title}
        toggleLabel={`${props.t(open ? 'collapse' : 'expand')}: ${title}`}
        icon={<IconChevronDownOutline14 />}
        open={open}
        expandable
        expandOnRowClick
        keepContentWhenOpen
        busy={state.saving}
        collapsedContent={state.dirty ? <Pill>{props.t('unsaved')}</Pill> : undefined}
        onToggle={() => { setOpen(!open) }}
      >
        <div ref={bodyRef}>
          <p>{props.t(props.descriptionKey)}</p>
          {!state.writable ? <p role="status">{props.t('readOnly')}</p> : null}
          {state.restartRequired
            ? <p role="status">{props.t('appliesRestart')}</p>
            : null}
          {props.children}
          <div>
            {state.failed ? <p role="status">{props.t('saveFailed')}</p> : null}
            <Button
              variant="outline"
              size="sm"
              disabled={!state.dirty || state.saving}
              onClick={props.onDiscard}
            >
              {props.t('discard')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={blocked}
              onClick={() => {
                saveHadFocus.current = bodyRef.current?.contains(document.activeElement) === true
                return props.onSave()
              }}
            >
              {props.t(state.saving ? 'saving' : 'save')}
            </Button>
          </div>
        </div>
      </DisclosureRow>
    </div>
  )
}
