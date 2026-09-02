/**
 * The Settings-row preset picker: a menu of presets over the shared Settings
 * selector pill naming the current one.
 *
 * Trust is the one thing the list always says: a locally authored preset is
 * exactly as privileged as the plugins it names, so the label marks it rather
 * than presenting every preset as shipped and vetted.
 */

import { IconChevronDownOutline14, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentPresetOption } from './settings-store.ts'
import { presetDisplayText, type AgentPresetSettingsKey } from './locales.ts'

/** What one surface passes to the shared picker. */
export interface PresetMenuProps {
  /** Presets to offer, in roster order. */
  options: readonly AgentPresetOption[]
  /** The preset the button names and the menu marks selected. */
  selectedId: string
  /** Text on the button; the surfaces word a pending roster differently. */
  label: string
  /** Active Web locale lookup. */
  t: (key: AgentPresetSettingsKey) => string
  /** Whether the trigger refuses interaction. */
  disabled: boolean
  /** Whether the menu is open — the surface owns this so it can force it shut. */
  open: boolean
  /** Report the menu's next open state. */
  onOpenChange: (open: boolean) => void
  /** Called with the picked preset once the menu has closed. */
  onSelect: (id: string) => void
}

/**
 * Render the preset picker.
 * @param props - the calling surface's copy, styling, and handlers.
 * @returns the menu and its trigger.
 */
export function PresetMenu({
  options, selectedId, label, t, disabled, open, onOpenChange, onSelect,
}: PresetMenuProps) {
  return (
    <Menu
      open={open}
      onClose={() => { onOpenChange(false) }}
      items={options.map((option) => {
        const name = presetDisplayText(option, t).name
        return {
          id: option.id,
          // All preset surfaces resolve copy the same way; the id is addressing,
          // not a label, except where no display name exists.
          label: option.trust === 'user' ? `${name} · ${t('userTrust')}` : name,
        }
      })}
      selectedId={selectedId}
      onSelect={(id) => {
        onOpenChange(false)
        onSelect(id)
      }}
      align="end"
      portal
      anchor={(
        <button
          type="button"
          className="dsw-settings-selector"
          aria-haspopup="menu"
          aria-expanded={open}
          disabled={disabled}
          onClick={() => { onOpenChange(!open) }}
        >
          {label}
          <IconChevronDownOutline14 className="dsw-settings-selector-chevron" />
        </button>
      )}
    />
  )
}
