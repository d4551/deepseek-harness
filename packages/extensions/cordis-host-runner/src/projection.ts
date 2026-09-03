/**
 * Source-free projections of one live Plugin into the row fragments the
 * inventory, snapshot, reference, and inspection results are assembled from.
 * Every fragment is a fresh object, so a result never aliases registry state a
 * later activation mutates, and every caller emits the same key set for the
 * same Plugin.
 * @module @deepseek-ai/dsh-cordis-host-runner/projection
 */

import type { DynamicCordisPlugin } from './registry.ts'
import type {
  CordisDynamicPackageId, CordisDynamicPluginRunId, DynamicCordisInventoryPackage,
  DynamicCordisRunAttempt,
} from './types.ts'

/** Which immutable Package a Plugin last activated and which one it is moving to. */
export interface DynamicCordisVersionPointers {
  /** Last Package that completed activation successfully. */
  currentPackageId?: CordisDynamicPackageId
  /** Package selected for a failed or in-progress transition. */
  nextPackageId?: CordisDynamicPackageId
}

/** Identity of the activation a Plugin is currently running, absent while stopped. */
export interface DynamicCordisActiveRunPointer {
  /** Current activation identity and the Package it runs. */
  activeRun?: {
    pluginRunId: CordisDynamicPluginRunId
    packageId: CordisDynamicPackageId
  }
}

/** The latest activation attempt, including pending approval and diagnostics. */
export interface DynamicCordisLatestRunPointer {
  /** Detached copy of the latest attempt. */
  latestRun?: DynamicCordisRunAttempt
}

/** Every lifecycle pointer a source-free Plugin row carries, in emission order. */
export interface DynamicCordisLifecyclePointers
  extends DynamicCordisVersionPointers, DynamicCordisActiveRunPointer, DynamicCordisLatestRunPointer {}

/**
 * Summarize a Plugin's immutable Package versions without their source code.
 * @param plugin - live Plugin whose Package map is read in define order.
 * @returns one metadata row per Package version.
 */
export function packageSummaries(plugin: DynamicCordisPlugin): DynamicCordisInventoryPackage[] {
  return [...plugin.packages.values()].map(definition => ({
    packageId: definition.packageId,
    name: definition.name,
    purpose: definition.purpose,
    hasHostHalf: definition.hostCode !== undefined,
    hasClientHalf: definition.clientCode !== undefined,
  }))
}

/**
 * Project a Plugin's version pointers, omitting each one that is unset.
 * @param plugin - live Plugin whose transition state is read.
 * @returns the pointers that currently exist.
 */
export function versionPointers(plugin: DynamicCordisPlugin): DynamicCordisVersionPointers {
  return {
    ...plugin.currentPackageId === undefined ? {} : { currentPackageId: plugin.currentPackageId },
    ...plugin.nextPackageId === undefined ? {} : { nextPackageId: plugin.nextPackageId },
  }
}

/**
 * Project the identity of a Plugin's current activation without its Host-only fields.
 * @param plugin - live Plugin whose run is read.
 * @returns the active-run identity, or an empty object while stopped.
 */
export function activeRunPointer(plugin: DynamicCordisPlugin): DynamicCordisActiveRunPointer {
  const run = plugin.run
  return run === undefined ? {} : { activeRun: { pluginRunId: run.pluginRunId, packageId: run.packageId } }
}

/**
 * Project a detached copy of a Plugin's latest activation attempt.
 * @param plugin - live Plugin whose attempt history is read.
 * @returns the copied attempt, or an empty object when none was recorded.
 */
export function latestRunPointer(plugin: DynamicCordisPlugin): DynamicCordisLatestRunPointer {
  const attempt = plugin.latestRun
  return attempt === undefined ? {} : { latestRun: cloneAttempt(attempt) }
}

/**
 * Project every lifecycle pointer a source-free Plugin row ends with.
 * @param plugin - live Plugin whose version, run, and attempt state is read.
 * @returns version pointers, active-run identity, and latest attempt, in that order.
 */
export function lifecyclePointers(plugin: DynamicCordisPlugin): DynamicCordisLifecyclePointers {
  return { ...versionPointers(plugin), ...activeRunPointer(plugin), ...latestRunPointer(plugin) }
}

/** Copy one activation attempt down to its mutable arrays and error record. */
function cloneAttempt(attempt: DynamicCordisRunAttempt): DynamicCordisRunAttempt {
  return {
    ...attempt,
    host: { ...attempt.host, waitingFor: [...attempt.host.waitingFor] },
    client: { ...attempt.client, waitingFor: [...attempt.client.waitingFor] },
    ...attempt.error === undefined ? {} : { error: { ...attempt.error } },
  }
}
