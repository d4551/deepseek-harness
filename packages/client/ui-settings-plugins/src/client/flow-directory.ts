import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardSaveResult, CardShell } from './card-form.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import { discardSettingsFlow, saveSettingsFlow, settingsFlowState, type SettingsFlowEditor } from './settings-flow.ts'

export interface SettingsFlowCopy {
  titleKey: PluginsSettingsLocaleKey
  descriptionKey: PluginsSettingsLocaleKey
}

export interface SettingsFlowMember extends SettingsFlowCopy {
  ns: string
}

export interface SettingsFlowView extends SettingsFlowCopy {
  id: string
  state: CardShell
  members: SettingsFlowMember[]
}

interface RegisteredEditor extends SettingsFlowCopy, SettingsFlowEditor {
  unsubscribe: ReturnType<SettingsFlowEditor['state']['subscribe']>
}

/** Joins host-declared flow membership to registered editors and their live drafts. */
export class SettingsFlowDirectory {
  readonly store = createSnapshotStore<readonly SettingsFlowView[]>([])
  private readonly editors = new Map<string, RegisteredEditor>()
  private readonly copy = new Map<string, SettingsFlowCopy>()
  private readonly unsubscribe: ReturnType<SettingsDescribeFace['subscribe']>
  private disposed = false

  constructor(
    private readonly describe: Pick<SettingsDescribeFace, 'getSnapshot' | 'subscribe'>,
    private readonly namespaces: () => readonly string[],
  ) {
    this.unsubscribe = describe.subscribe(() => { this.publish() })
  }

  refresh(): readonly SettingsFlowView[] {
    return this.publish()
  }

  registerFlow(id: string, copy: SettingsFlowCopy): () => boolean {
    if (this.copy.has(id)) throw new Error(`settings flow ${id} is already registered`)
    this.copy.set(id, copy)
    this.publish()
    return () => {
      const removed = this.copy.delete(id)
      this.publish()
      return removed
    }
  }

  registerEditor(ns: string, editor: SettingsFlowEditor & SettingsFlowCopy): () => boolean {
    if (this.editors.has(ns)) throw new Error(`settings editor ${ns} is already registered`)
    const unsubscribe = editor.state.subscribe(() => { this.publish() })
    this.editors.set(ns, { ...editor, unsubscribe })
    this.publish()
    return () => {
      unsubscribe()
      const removed = this.editors.delete(ns)
      this.publish()
      return removed
    }
  }

  save(id: string): Promise<CardSaveResult> {
    return saveSettingsFlow(this.members(id))
  }

  discard(id: string): CardShell {
    return discardSettingsFlow(this.members(id))
  }

  dispose(): boolean {
    if (this.disposed) return false
    this.disposed = true
    this.unsubscribe()
    for (const editor of this.editors.values()) editor.unsubscribe()
    this.editors.clear()
    this.copy.clear()
    this.store.set([])
    return true
  }

  private members(id: string): RegisteredEditor[] {
    const flow = this.store.getSnapshot().find(view => view.id === id)
    if (flow === undefined) throw new Error(`settings flow ${id} is unavailable`)
    return flow.members.map(({ ns }) => {
      const editor = this.editors.get(ns)
      if (editor === undefined) throw new Error(`settings editor ${ns} is unavailable`)
      return editor
    })
  }

  private publish(): readonly SettingsFlowView[] {
    if (this.disposed) return this.store.getSnapshot()
    const served = new Map(this.describe.getSnapshot().view?.namespaces.map(view => [view.ns, view.flow]))
    const registered = new Set(this.namespaces())
    const grouped = new Map<string, SettingsFlowMember[]>()
    for (const [ns, editor] of this.editors) {
      if (!registered.has(ns)) continue
      const id = served.get(ns)
      if (id === undefined) continue
      const members = grouped.get(id) ?? []
      members.push({ ns, titleKey: editor.titleKey, descriptionKey: editor.descriptionKey })
      grouped.set(id, members)
    }
    const flows: SettingsFlowView[] = []
    for (const [id, members] of grouped) {
      const copy = this.copy.get(id)
      if (copy === undefined) throw new Error(`settings flow ${id} has no registered presentation`)
      const editors = members.map(({ ns }) => {
        const editor = this.editors.get(ns)
        if (editor === undefined) throw new Error(`settings editor ${ns} is unavailable`)
        return editor
      })
      flows.push({ id, ...copy, members, state: settingsFlowState(editors) })
    }
    const previous = this.store.getSnapshot()
    if (JSON.stringify(previous) !== JSON.stringify(flows)) this.store.set(flows)
    return this.store.getSnapshot()
  }
}
