import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { CardActions, CardSaveResult, CardShell } from './card-form.ts'

/** An editor contributes its existing state and persistence actions to a flow. */
export interface SettingsFlowEditor extends Pick<CardActions, 'save' | 'discard'> {
  state: ObservableSnapshot<CardShell>
}

/** Shared editing state for the namespaces in one discovered settings flow. */
export function settingsFlowState(editors: readonly SettingsFlowEditor[]): CardShell {
  const states = editors.map(editor => editor.state.getSnapshot())
  return {
    available: states.length > 0 && states.every(state => state.available),
    writable: states.length > 0 && states.every(state => state.writable),
    dirty: states.some(state => state.dirty),
    invalid: states.some(state => state.invalid),
    saving: states.some(state => state.saving),
    failed: states.some(state => state.failed),
    restartRequired: states.some(state => state.restartRequired),
  }
}

/** Save the complete valid flow in namespace order, retaining each refused draft. */
export async function saveSettingsFlow(editors: readonly SettingsFlowEditor[]): Promise<CardSaveResult> {
  const state = settingsFlowState(editors)
  if (!state.available || !state.writable || state.invalid || state.saving) return 'blocked'
  if (!state.dirty) return 'unchanged'
  for (const editor of editors) {
    const current = editor.state.getSnapshot()
    if (!current.available || !current.writable || current.invalid || current.saving) return 'blocked'
    if (!current.dirty) continue
    const result = await editor.save()
    if (result === 'failed' || result === 'blocked') return result
  }
  return 'saved'
}

/** Discard a flow's drafts only when none of its writes are pending. */
export function discardSettingsFlow(editors: readonly SettingsFlowEditor[]): CardShell {
  const state = settingsFlowState(editors)
  if (state.saving) return state
  for (const editor of editors) editor.discard()
  return settingsFlowState(editors)
}
