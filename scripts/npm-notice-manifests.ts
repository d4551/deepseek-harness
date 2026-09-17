/** Workspace manifest declarations used by the third-party notices generator. */
import { posix, win32 } from 'node:path'

/** Dependency sections included in third-party disclosure. */
export const DEPENDENCY_KINDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'] as const

/** Package metadata consumed by dependency disclosure. */
export interface Manifest {
  name?: string
  version?: string
  private?: boolean
  license?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** One repository-local dependency and its declaring manifest section. */
export interface LocalPackageDeclaration {
  name: string
  manifest: string
  kind: typeof DEPENDENCY_KINDS[number]
  path: string
}

/**
 * Collect file dependencies from every workspace dependency section.
 * @param manifests - Complete manifests keyed by normalized repository-relative path.
 * @returns Declarations with package paths resolved relative to their declaring manifest.
 * @throws When a file dependency is empty, absolute or outside the repository.
 */
export function localPackageDeclarations(manifests: ReadonlyMap<string, Manifest>): LocalPackageDeclaration[] {
  const declarations: LocalPackageDeclaration[] = []
  for (const [manifest, metadata] of manifests) {
    for (const kind of DEPENDENCY_KINDS) {
      for (const [name, spec] of Object.entries(metadata[kind] ?? {})) {
        if (!spec.startsWith('file:')) continue
        const local = spec.slice('file:'.length).replaceAll('\\', '/')
        const path = posix.normalize(posix.join(posix.dirname(manifest), local))
        if (local.length === 0 || posix.isAbsolute(local) || win32.isAbsolute(local)
          || path === '..' || path.startsWith('../')) {
          throw new Error(`${manifest}: ${kind}.${name} must name a repository-local package, received ${spec}`)
        }
        declarations.push({ name, manifest, kind, path })
      }
    }
  }
  return declarations.sort((left, right) => left.name.localeCompare(right.name)
    || left.manifest.localeCompare(right.manifest) || left.kind.localeCompare(right.kind))
}
