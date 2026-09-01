/**
 * The workspace packages a tsdown config resolves while it loads.
 *
 * `tsdown.config.ts` imports the Typert plugin from a workspace package's
 * `lib/types` emit, and Node resolves that module's whole import graph before
 * the build starts. Every workspace package that graph reaches by name
 * resolves to a `lib/index.js` bundle, which only a tsdown pass writes — so
 * the packages named here are bundled by `tsdown.bootstrap.config.ts` first.
 * `scripts/check-workspace-constraints.ts` checks that `build:lib:host` still
 * runs that pass ahead of the plugin-bearing one.
 */

import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'

/** Relative specifiers a config file resolves at load time. */
const RELATIVE_IMPORT = /from '(\.\/[^']+)'/g

interface DependencyManifest {
  dependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

/**
 * The package directory a repository-relative file belongs to.
 * @param root - repository root the specifier is relative to.
 * @param specifier - relative specifier as written in the config.
 * @returns the nearest ancestor directory holding a `package.json`, or undefined for a file outside every package.
 */
function owningPackageDirectory(root: string, specifier: string): string | undefined {
  let dir = dirname(resolve(root, specifier))
  while (dir !== root && dir.startsWith(root)) {
    if (existsSync(join(dir, 'package.json'))) return dir
    dir = dirname(dir)
  }
  return undefined
}

/**
 * Workspace packages a config file imports a file from.
 * @param root - repository root.
 * @param configSource - the config file's contents.
 * @returns absolute directories, in first-import order without repeats.
 */
export function configToolingPackages(root: string, configSource: string): string[] {
  const directories: string[] = []
  for (const match of configSource.matchAll(RELATIVE_IMPORT)) {
    const specifier = match[1]
    if (specifier === undefined) continue
    const dir = owningPackageDirectory(root, specifier)
    if (dir !== undefined && !directories.includes(dir)) directories.push(dir)
  }
  return directories
}

/**
 * Workspace packages one package declares as runtime dependencies.
 *
 * Resolution runs through the installed link rather than a directory scan, so
 * a name that is declared but not installed fails loud here instead of
 * producing a bootstrap pass that silently omits it.
 * @param packageDir - absolute directory of the declaring package.
 * @returns absolute directories of its workspace runtime dependencies.
 */
function workspaceDependencyDirectories(packageDir: string): string[] {
  const manifestPath = join(packageDir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DependencyManifest
  const declared = { ...manifest.dependencies, ...manifest.optionalDependencies }
  const require = createRequire(manifestPath)
  return Object.entries(declared)
    .filter(([, range]) => range.startsWith('workspace:'))
    .map(([name]) => dirname(require.resolve(`${name}/package.json`)))
}

/**
 * Every workspace package that must carry its bundle before a config loads.
 *
 * The packages the config imports from are excluded: the config reaches their
 * `lib/types` emit by path, which the preceding `tsc -b` wrote.
 * @param root - repository root.
 * @param configSource - contents of the config whose load must succeed.
 * @returns repository-relative directories, sorted, with `/` separators for tsdown's workspace match.
 */
export function buildToolingBootstrapClosure(root: string, configSource: string): string[] {
  const seeds = configToolingPackages(root, configSource)
  const visited = new Set(seeds)
  const closure = new Set<string>()
  const pending = [...seeds]
  while (pending.length > 0) {
    const dir = pending.pop() as string
    for (const dependency of workspaceDependencyDirectories(dir)) {
      if (visited.has(dependency)) continue
      visited.add(dependency)
      closure.add(dependency)
      pending.push(dependency)
    }
  }
  return [...closure].map(dir => relative(root, dir).split(sep).join('/')).sort()
}
