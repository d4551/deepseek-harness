/**
 * Public analyzer option and registration types.
 */

import type { TypertFace } from './model.ts'
import type { ParsedConfig } from './analyzer-config.ts'

/** One package face whose public export graph contains Typert business declarations. */
export interface DiscoveredTypertPackage {
  readonly package: string
  readonly root: string
  readonly faces: readonly TypertFace[]
}

/** One package face registration discovered from an aggregate tsconfig. */
export interface PackageRegistration {
  /** The face whose aggregate references this package project. */
  readonly face: TypertFace
  /** The package manifest name. */
  readonly name: string
  /** Real package root directory. */
  readonly root: string
  /** The package's own parsed tsconfig. */
  readonly config: ParsedConfig
  /** The parsed package.json content. */
  readonly manifest: object
  /** Export subpaths owned by this face for dual-face packages. */
  readonly exportSubpaths?: readonly string[]
}
