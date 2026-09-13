/** Roster and selection work admitted by synchronous surface notifications. */
import { AgentPresetSeatController } from './seat-store.ts'
import type { AgentPresetSectionController } from './section-store.ts'
import { messageOf, type AgentPresetSettingsController } from './settings-store.ts'

type SurfaceController = AgentPresetSettingsController | AgentPresetSectionController | AgentPresetSeatController

/** Own notification work until its result reaches the surface or disposal reports its failure. */
export class AgentPresetSurfaceUpdates {
  private readonly pending = new Map<symbol, Promise<[PromiseSettledResult<void>]>>()
  private closing: Promise<void> | undefined
  private stopped = false

  /** Schedule a roster read whose result is published by its surface controller. */
  load(controller: SurfaceController): void {
    this.admit(controller, 'load')
  }

  /** Reconcile the staged choice after a session-list notification. */
  apply(controller: AgentPresetSeatController): void {
    this.admit(controller, 'apply')
  }

  private admit(controller: SurfaceController, action: 'load' | 'apply'): void {
    if (this.stopped) throw new Error('Agent preset surface updates disposed')
    const key = Symbol()
    this.pending.set(key, Promise.allSettled([this.complete(controller, action, key)]))
  }

  private async complete(controller: SurfaceController, action: 'load' | 'apply', key: symbol): Promise<void> {
    const [result] = await Promise.allSettled([Promise.try<void | string, []>(() => {
      if (action === 'load') return controller.load()
      if (!(controller instanceof AgentPresetSeatController)) throw new Error('Preset selection requires a session seat')
      return controller.apply()
    })])
    if (result.status === 'rejected') {
      controller.store.update((state) => {
        state.error = messageOf(result.reason)
        if ('status' in state) state.status = 'error'
        if ('busy' in state) state.busy = false
      })
    }
    this.pending.delete(key)
  }

  /** Refuse further notifications and join every operation already admitted. */
  dispose(): Promise<void> {
    if (this.closing !== undefined) return this.closing
    this.stopped = true
    this.closing = this.drain()
    return this.closing
  }

  private async drain(): Promise<void> {
    const results = (await Promise.all(this.pending.values())).flat()
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length > 0) {
      throw new AggregateError(failures.map((result): unknown => result.reason), 'Agent preset updates failed')
    }
  }
}
