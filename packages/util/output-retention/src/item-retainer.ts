/**
 * Head-bounded retention for ordered logical units.
 * @module @deepseek-ai/dsh-output-retention/item-retainer
 */
import { assertBudget } from './budget.ts'
import type { ItemRetentionStrategy, Omitted, PushDecision, RetainedItems } from './index.ts'

/**
 * Bounds an ordered stream of logical units, keeping the first `maxItems`
 * ({@link ItemRetentionStrategy} `head`). `push()` reports, per unit, whether it
 * was kept and whether the retained result is now truncated.
 *
 * Grouping, sorting, path mapping, per-unit preview truncation, and any
 * `incomplete` state stay OUTSIDE the retainer: it counts and keeps, nothing
 * more. The caller pushes prepared logical units and, after {@link finish},
 * groups/sorts the retained subset itself.
 */
export class ItemRetainer<T> {
  private readonly maxItems: number
  private readonly items: T[] = []
  private seen = 0
  private omittedCount = 0

  /** @param strategy Head strategy: `maxItems` (non-negative integer). */
  constructor(strategy: ItemRetentionStrategy) {
    assertBudget(strategy.maxItems, 'maxItems')
    this.maxItems = strategy.maxItems
  }

  /**
   * Offer one unit. Kept when the retainer is below `maxItems`; otherwise dropped
   * and counted as omitted. Callers keep pushing all observed units, so the final
   * {@link Omitted} count is exact.
   *
   * @param item The prepared logical unit (path, flat match, source).
   * @returns The per-push {@link PushDecision}.
   */
  push(item: T): PushDecision {
    this.seen++
    if (this.items.length < this.maxItems) {
      // Reached only below the cap, before any omission (items only grow, the
      // cap is fixed), so nothing has been dropped yet: truncated is always false.
      this.items.push(item)
      return { kept: true, truncated: false }
    }
    this.omittedCount++
    return {
      kept: false,
      truncated: true,
    }
  }

  /**
   * Finalize and report what was kept and omitted.
   *
   * @returns The {@link RetainedItems} snapshot (safe to group/sort downstream).
   */
  finish(): RetainedItems<T> {
    const truncated = this.omittedCount > 0
    return {
      items: this.items,
      truncated,
      seen: this.seen,
      kept: this.items.length,
      omitted: truncated
        ? { kind: 'exact', count: this.omittedCount }
        : { kind: 'none' },
    }
  }
}
