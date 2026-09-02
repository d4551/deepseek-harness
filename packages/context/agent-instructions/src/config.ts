/**
 * Configuration normalization for workspace instruction discovery and rendering.
 *
 * @module @deepseek-ai/dsh-agent-instructions/config
 */

import { relative } from 'node:path'
import z from '@deepseek-ai/schemastery'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

const DEFAULT_PROJECT_ROOT_MARKERS = ['.git'] as const
const DEFAULT_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const
const DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES = ['AGENTS.local.md', 'CLAUDE.local.md'] as const
const DEFAULT_MAX_SOURCE_BYTES = 1_048_576
// Eight times the per-file cap. A batch reads every accepted instruction file
// into memory before rendering trims it, so the aggregate bounds a pathological
// tree while staying far above real instruction sets, which run to kilobytes.
const DEFAULT_MAX_TOTAL_SOURCE_BYTES = 8_388_608
const RESERVED_PATH_SEGMENTS = new Set(['', '.', '..'])

/** User-facing workspace instruction loader configuration. */
export interface Config {
  /** Harness home containing the fixed user-global `AGENTS.md`; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
  /** Directory entries that identify the project root while walking upward from the session cwd. */
  projectRootMarkers?: string[]
  /** UTF-8 byte cap for one rendered baseline or dynamic batch; non-positive or non-finite disables loading. */
  maxBytes: number
  /** Maximum UTF-8 bytes read from one instruction file; larger files are ignored. */
  maxSourceBytes?: number
  /**
   * Maximum UTF-8 bytes read across one baseline or reconciliation batch. Each
   * accepted file is charged against it in discovery order; once the remainder
   * cannot hold a file, that file and every later one is ignored.
   */
  maxTotalSourceBytes?: number
  /**
   * Ordered same-directory project candidates; every existing file loads, with
   * per-directory trimmed-content duplicates collapsed to the earliest candidate.
   */
  instructionFileCandidates?: string[]
  /**
   * Ordered same-directory local-overlay candidates loaded after the base files
   * under the same per-directory trimmed-content dedup; empty disables the overlay.
   */
  localInstructionFileCandidates?: string[]
}

export const Config: z<Config> = z.object({
  dshHome: z.string(),
  projectRootMarkers: z.array(z.string()).default([...DEFAULT_PROJECT_ROOT_MARKERS]),
  maxBytes: z.number().required(),
  maxSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_SOURCE_BYTES),
  maxTotalSourceBytes: z.number().step(1).min(1).default(DEFAULT_MAX_TOTAL_SOURCE_BYTES),
  instructionFileCandidates: z.array(z.string()).default([...DEFAULT_INSTRUCTION_FILE_CANDIDATES]),
  localInstructionFileCandidates: z.array(z.string()).default([...DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES]),
})

/** Normalized instruction discovery configuration. */
export interface ResolvedDiscoveryConfig {
  dshHome: string
  projectRootMarkers: string[]
  instructionFileCandidates: string[]
  localInstructionFileCandidates: string[]
}

/** Normalized configuration used by discovery and reconciliation. */
export interface ResolvedConfig extends ResolvedDiscoveryConfig {
  maxBytes: number
  maxSourceBytes: number
  maxTotalSourceBytes: number
}

/**
 * Identify the discovery, precedence, and budget semantics of one baseline.
 * The additional workspace roots join the identity because they widen
 * discovery: a session that gains or loses a root must rebuild its baseline
 * rather than keep one loaded from a different set of directories.
 * @param config - normalized plugin configuration.
 * @param cwd - absolute session working directory.
 * @param projectRoot - project root selected for the current baseline.
 * @param additionalRoots - the session's additional workspace roots, in order.
 * @returns stable serialized identity for compatibility checks on resume.
 */
export function workspaceBaselineIdentity(
  config: ResolvedConfig,
  cwd: string,
  projectRoot: string,
  additionalRoots: readonly string[],
): string {
  return JSON.stringify({
    projectRoot: relative(cwd, projectRoot),
    additionalRoots: additionalRoots.map(root => relative(cwd, root)),
    projectRootMarkers: config.projectRootMarkers,
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes,
    maxTotalSourceBytes: config.maxTotalSourceBytes,
    instructionFileCandidates: config.instructionFileCandidates,
    localInstructionFileCandidates: config.localInstructionFileCandidates,
  })
}

/**
 * Resolve defaults, the harness home, and valid same-directory candidates.
 * @param config - user-facing plugin configuration.
 * @returns normalized runtime configuration.
 */
export function resolveConfig(config: Config): ResolvedConfig {
  return {
    ...resolveDiscoveryConfig(config),
    maxBytes: config.maxBytes,
    maxSourceBytes: config.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
    maxTotalSourceBytes: config.maxTotalSourceBytes ?? DEFAULT_MAX_TOTAL_SOURCE_BYTES,
  }
}

/**
 * Resolve the subset of configuration used before instruction content is rendered.
 * @param config - optional discovery controls.
 * @returns normalized home, root markers, and instruction candidates.
 */
export function resolveDiscoveryConfig(
  config: Pick<Config, 'dshHome' | 'projectRootMarkers' | 'instructionFileCandidates' | 'localInstructionFileCandidates'>,
): ResolvedDiscoveryConfig {
  return {
    dshHome: resolveDshHome(config.dshHome),
    projectRootMarkers: config.projectRootMarkers ?? [...DEFAULT_PROJECT_ROOT_MARKERS],
    instructionFileCandidates: resolveInstructionFileCandidates(
      config.instructionFileCandidates,
      DEFAULT_INSTRUCTION_FILE_CANDIDATES,
    ),
    localInstructionFileCandidates: resolveInstructionFileCandidates(
      config.localInstructionFileCandidates,
      DEFAULT_LOCAL_INSTRUCTION_FILE_CANDIDATES,
    ),
  }
}

function resolveInstructionFileCandidates(candidates: string[] | undefined, fallback: readonly string[]): string[] {
  return (candidates ?? [...fallback]).filter(candidate => (
    !RESERVED_PATH_SEGMENTS.has(candidate) && !/[\\/]/.test(candidate)
  ))
}
