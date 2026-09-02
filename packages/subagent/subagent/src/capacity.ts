/**
 * One-shot run admission for the subagent seam: hold the concurrency slot a
 * started run occupies until that run reaches a terminal state.
 *
 * The service acquires the slot after validation and before dispatching to the
 * provider, so a delayed start never reaches `SubagentProvider.start`. Once the
 * provider publishes the run, the slot belongs to the run rather than the call,
 * and every settlement path returns it: the result resolving, the result
 * rejecting on an infrastructure fault, and the holder's `dispose()` — which is
 * also how an interrupted or abandoned run gives its slot back.
 *
 * @module @deepseek-ai/dsh-subagent/capacity
 */

import type { CapacityRelease } from '@deepseek-ai/dsh-capacity-gate'
import type { SubagentRun } from './types.ts'

/**
 * Bind one granted concurrency slot to a published run's lifetime.
 *
 * The returned run forwards identity and result unchanged and adds slot release
 * to disposal. `release` is idempotent, so the settlement that happens first
 * returns the slot and the other paths are no-ops. Disposal stays one memoized
 * teardown, which the seam's holders observe as the same promise from every
 * call.
 * @param run - the run the provider just published.
 * @param release - the granted slot's release.
 * @returns the run consumers hold, releasing the slot on every settlement path.
 */
export function holdSlotUntilSettled(run: SubagentRun, release: CapacityRelease): SubagentRun {
  // Attaching to `result` covers the ordinary path even when a holder never
  // disposes, and the seam's own contract says a rejected result is terminal.
  void run.result.then(release, release)
  const teardown = async (): Promise<void> => {
    try {
      await run.dispose()
    } finally {
      release()
    }
  }
  let disposal: Promise<void> | undefined
  return {
    id: run.id,
    localAgent: run.localAgent,
    result: run.result,
    dispose: (): Promise<void> => (disposal ??= teardown()),
  }
}
