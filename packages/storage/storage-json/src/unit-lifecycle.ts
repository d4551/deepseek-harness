/**
 * The open-slot lifecycle both JSON unit layouts run: the closed guard every
 * operation takes, the in-flight durable writes `close` drains before releasing
 * the backend's open-slot, and the declared-global check. The layouts differ in
 * what they write, not in when a unit stops accepting work.
 * @module @deepseek-ai/dsh-storage-json/src/unit-lifecycle
 */

import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnitDescriptor } from '@deepseek-ai/dsh-storage'

/** Open-slot lifecycle for one opened JSON unit, whatever its layout writes. */
export abstract class JsonUnitLifecycle {
  private closed = false
  /** In-flight durable writes; close() drains them before releasing the unit. */
  private readonly inFlight = new Set<Promise<void>>()

  /**
   * @param descriptor - Static identity and shape of the unit.
   * @param onClose - Backend callback releasing the unit's open-slot.
   */
  constructor(
    protected readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {}

  /** Drain in-flight writes and release the unit. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) {
      await Promise.allSettled(this.inFlight)
      return
    }
    this.closed = true
    await Promise.allSettled(this.inFlight)
    this.onClose()
  }

  /** Reject work on a unit whose open-slot was already released. */
  protected assertOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `unit '${this.descriptor.name}' is closed`)
    }
  }

  /** Reject a global-slot write the descriptor never declared. */
  protected assertGlobalDeclared(): void {
    if (!this.descriptor.hasGlobal) {
      throw new Error(`unit '${this.descriptor.name}' does not declare a global slot`)
    }
  }

  /**
   * Track one durable write so `close` drains it.
   * @param write - the durable write the caller still awaits.
   * @returns the same promise, so the caller keeps observing its rejection.
   */
  protected tracked(write: Promise<void>): Promise<void> {
    this.inFlight.add(write)
    // Swallow only on the tracking branch: the caller still awaits `write`
    // itself, so rejections stay observed exactly once.
    write.catch(() => {}).finally(() => this.inFlight.delete(write))
    return write
  }
}
