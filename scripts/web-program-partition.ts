/** Validate that every authored `apps/web` TypeScript file has exactly one owning program. */

import { existsSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { isEmittedOrVendored, uniqueRepoFiles } from './repo-files.ts'
import { parseConfigFile, readConfigFile } from './ts7-session.ts'

/** Repository-relative globs covering every authored TypeScript file the web application owns. */
const WEB_SOURCE_PATTERNS = ['apps/web/**/*.ts', 'apps/web/**/*.tsx'] as const

/** Repository-relative prefix the partition covers. */
const WEB_PREFIX = 'apps/web/'

interface ReferencingConfig {
  readonly references?: ReadonlyArray<{ readonly path?: unknown }>
}

/**
 * Report `apps/web` TypeScript files that no program checks or that two programs check.
 *
 * `apps/web` straddles the two aggregates: the browser application and its
 * shell-mounting tests belong to the Client program, while the browser e2e lane
 * reads Host services and belongs to the Host program. Neither aggregate can
 * hold the other's files, because both sides merge the cordis `Context`
 * interface under the same keys. That makes membership a partition, and a
 * partition needs both halves checked: a file in no program is silently
 * unchecked, and a file in both is a Context-merge collision waiting for its
 * first Host or Client type reference.
 *
 * Membership is read from the resolved root file list of each aggregate and of
 * every project its Project References reach, so it follows the configs rather
 * than restating them. The check is scoped to `apps/web` because three
 * repository packages (`host/webserver`, `compaction/compaction`,
 * `typert/registry`) are deliberate shared leaves that both aggregates
 * type-check; no `apps/web` file has that standing.
 *
 * @param root - absolute repository root holding both aggregate tsconfigs.
 * @returns sorted repo-relative diagnostics, empty when the partition holds.
 */
export function collectWebProgramPartitionViolations(root: string): string[] {
  const host = programRootFiles(root, resolve(root, 'tsconfig.host.json'))
  const client = programRootFiles(root, resolve(root, 'tsconfig.client.json'))
  const violations: string[] = []
  for (const file of webSourceFiles(root)) {
    const inHost = host.has(file)
    const inClient = client.has(file)
    if (inHost && inClient) {
      violations.push(
        `${file}: checked by both the Host and Client programs; one program cannot hold both sides of the cordis Context merges`,
      )
    } else if (!inHost && !inClient) {
      violations.push(
        `${file}: checked by no program; give it the \`.client.\` infix to join the Client program, or leave it unmarked for the Host program`,
      )
    }
  }
  return violations.sort()
}

/**
 * List the authored TypeScript files under `apps/web` in repo-relative form.
 * @param root - absolute repository root.
 * @returns repo-relative paths, excluding emitted and installed trees.
 */
function webSourceFiles(root: string): string[] {
  return uniqueRepoFiles(root, WEB_SOURCE_PATTERNS, isEmittedOrVendored)
    .map(file => repoPath(root, file.abs))
    .sort()
}

/**
 * Collect the root files of one aggregate and of every project it reaches.
 * @param root - absolute repository root.
 * @param aggregate - absolute path of the aggregate tsconfig to expand.
 * @returns repo-relative root files under `apps/web`.
 */
function programRootFiles(root: string, aggregate: string): Set<string> {
  const files = new Set<string>()
  const pending = [aggregate]
  const visited = new Set<string>()
  for (let configPath = pending.pop(); configPath !== undefined; configPath = pending.pop()) {
    if (visited.has(configPath) || !existsSync(configPath)) continue
    visited.add(configPath)
    for (const fileName of parseConfigFile(configPath).fileNames) {
      const file = repoPath(root, fileName)
      if (file.startsWith(WEB_PREFIX)) files.add(file)
    }
    for (const reference of projectReferences(root, configPath)) pending.push(reference)
  }
  return files
}

/**
 * Resolve the Project Reference targets one config declares.
 * @param root - absolute repository root used for error paths.
 * @param configPath - absolute path of the config to read.
 * @returns absolute config paths, with directory references resolved to `tsconfig.json`.
 */
function projectReferences(root: string, configPath: string): string[] {
  const read = readConfigFile(configPath)
  if (read.error !== undefined) throw new Error(`${repoPath(root, configPath)}: ${read.error.messageText}`)
  const config = read.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`${repoPath(root, configPath)}: expected a JSON object`)
  }
  return ((config as ReferencingConfig).references ?? [])
    .map(reference => reference.path)
    .filter((path): path is string => typeof path === 'string')
    .map((path) => {
      const target = resolve(dirname(configPath), path)
      return target.endsWith('.json') ? target : resolve(target, 'tsconfig.json')
    })
}

/**
 * Convert an absolute path to its repo-relative POSIX form.
 * @param root - absolute repository root.
 * @param absolutePath - absolute path inside the repository.
 * @returns repo-relative path with `/` separators.
 */
function repoPath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join('/')
}
