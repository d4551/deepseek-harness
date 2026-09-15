import { setTimeout } from 'node:timers/promises'

/**
 * Observe persisted state within a deadline, draining each read before settlement.
 * @param observe - Read the current durable state; read failures propagate directly.
 * @param failure - Diagnostic identifying the state absent at the deadline.
 * @param timeoutMs - Total observation budget, including time spent reading.
 * @param intervalMs - Maximum delay between completed reads.
 */
export async function waitForPersistence(
  observe: () => boolean | Promise<boolean>,
  failure: Error,
  timeoutMs: number,
  intervalMs: number,
): Promise<void> {
  const deadline = performance.now() + timeoutMs
  for (;;) {
    if (performance.now() >= deadline) throw failure
    const ready = await observe()
    const remaining = deadline - performance.now()
    if (remaining <= 0) throw failure
    if (ready) return
    await setTimeout(Math.min(intervalMs, remaining))
  }
}
