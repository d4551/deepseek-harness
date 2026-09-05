/** Machine value of the preset that requires an explicit GUI risk gate. */
export const FULL_ACCESS_PRESET = 'danger-full-access'

/** Locale keys for the built-in permission presets. */
export type PermissionPresetLabelKey =
  | 'preset.read-only'
  | 'preset.workspace-write'
  | 'preset.danger-full-access'

/** Resolve a built-in preset machine value to its locale key. */
function builtInLabelKey(value: string): PermissionPresetLabelKey | undefined {
  switch (value) {
    case 'read-only': return 'preset.read-only'
    case 'workspace-write': return 'preset.workspace-write'
    case FULL_ACCESS_PRESET: return 'preset.danger-full-access'
    default: return undefined
  }
}

/**
 * Convert conventional kebab-case preset names into user-facing title case.
 * @param name - host-supplied preset label or key.
 * @returns the title-cased conventional key, or a non-kebab label unchanged.
 */
export function displayPresetName(name: string): string {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) return name
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/**
 * Render a permission preset under its product label.
 * @param value - preset machine value.
 * @param name - host-supplied preset name.
 * @param t - translator for built-in preset labels.
 * @returns the localized built-in label or the conventional display name.
 */
export function displayPermissionPreset(
  value: string,
  name: string,
  t: (key: PermissionPresetLabelKey) => string,
): string {
  const key = builtInLabelKey(value)
  return key === undefined ? displayPresetName(name) : t(key)
}
