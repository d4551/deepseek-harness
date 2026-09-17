import type { SurfaceAudit } from './index.ts'

/** Execution observer for a native axe result and its strict validation. */
export interface AccessibilityExecutionObserver {
  /** Capture the execution owner before axe starts; receive its result after completion. */
  started(): (audit: SurfaceAudit) => void
  /** Record a successful 100-point validation of results produced by axe. */
  validated(audits: readonly SurfaceAudit[]): void
}

const observers = new Set<AccessibilityExecutionObserver>()
const nativeAudits = new WeakSet<SurfaceAudit>()

/**
 * Observe native audit execution without replacing axe or its assertions.
 * @param observer - owner of execution evidence for the current test run.
 * @returns a disposer that stops delivering evidence to this owner.
 */
export function observeAccessibilityExecution(observer: AccessibilityExecutionObserver): () => boolean {
  observers.add(observer)
  return () => observers.delete(observer)
}

/**
 * Capture observers before native axe starts its asynchronous work.
 * @returns the completion owner for the native result.
 */
export function beginAccessibilityAudit(): (audit: SurfaceAudit) => void {
  const completions = [...observers].map(observer => observer.started())
  return (audit) => {
    nativeAudits.add(audit)
    for (const complete of completions) complete(audit)
  }
}

/**
 * Publish strict validation only for actual native result identities.
 * @param audits - results accepted by the accessibility failure check.
 * @param minimum - requested score floor.
 */
export function recordAccessibilityValidation(audits: readonly SurfaceAudit[], minimum: number): void {
  if (minimum !== 100 || !audits.every(audit => nativeAudits.has(audit))) return
  for (const observer of observers) observer.validated(audits)
}
