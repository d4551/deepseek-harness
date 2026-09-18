/**
 * Locate the workspace root and read a package manifest by name.
 *
 * tsdown 0.22's unrun loader compiles each package tsdown.config.ts into
 * node_modules/.unrun. A fixed ../.. walk from import.meta.url then lands in
 * packages/ or node_modules/. Walking until bun.lock and the packages
 * workspaces glob agree is the loader-independent contract.
 */
import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Workspace glob every Host/Client preset uses to locate package manifests. */
export const WORKSPACE_PACKAGE_MANIFESTS = 'packages/*/*/package.json'

export type JsonNode =
  | string
  | number
  | boolean
  | null
  | JsonNode[]
  | { readonly [key: string]: JsonNode | undefined }

/** The manifest fields the build faces read to state their own module edges. */
export interface WorkspaceManifest {
  readonly name: string
  /** Sections a real install materializes on disk next to the built package. */
  readonly dependencies?: Readonly<Record<string, string>>
  readonly peerDependencies?: Readonly<Record<string, string>>
  readonly optionalDependencies?: Readonly<Record<string, string>>
  readonly dsh?: { readonly client?: { readonly external?: JsonNode } }
}

/**
 * Parse JSON text into an object document. Throws when the document is not an object.
 * @param source - raw JSON text.
 * @param label - path used in the error.
 */
export function jsonObject(source: string, label: string): { readonly [key: string]: JsonNode | undefined } {
  const parsed: JsonNode = JSON.parse(source)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`tsdown: ${label} is not an object`)
  }
  return parsed
}

/**
 * Whether `directory` is this repository's workspace root: bun.lock plus a
 * `package.json` whose workspaces list includes the packages glob.
 */
function hasWorkspaceLayout(directory: string): boolean {
  const lock = resolve(directory, 'bun.lock')
  const manifestPath = resolve(directory, 'package.json')
  if (!existsSync(lock) || !existsSync(manifestPath)) return false
  const workspaces = jsonObject(readFileSync(manifestPath, 'utf8'), manifestPath).workspaces
  return Array.isArray(workspaces) && workspaces.some(entry => entry === 'packages/*/*')
}

/**
 * Walk ancestors of `start` until {@link hasWorkspaceLayout} succeeds.
 * @param start - absolute directory to begin the walk.
 */
function walkRepositoryRoot(start: string): string | undefined {
  let directory = start
  for (;;) {
    if (hasWorkspaceLayout(directory)) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}

/**
 * Locate the workspace root without trusting `import.meta.url` depth.
 * Cwd first (workspace builds start at the root), then the loading module.
 *
 * @param cwd - process cwd, overridable in tests.
 * @param fromMeta - directory of the loading module, overridable in tests.
 */
export function resolveRepositoryRoot(
  cwd: string = process.cwd(),
  fromMeta: string = fileURLToPath(new URL('.', import.meta.url)),
): string {
  const fromCwd = walkRepositoryRoot(cwd)
  if (fromCwd !== undefined) return fromCwd
  const fromFile = walkRepositoryRoot(fromMeta)
  if (fromFile !== undefined) return fromFile
  throw new Error('tsdown: cannot locate the workspace root (bun.lock + packages workspaces)')
}

function stringRecord(value: JsonNode | undefined, label: string): Readonly<Record<string, string>> | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`tsdown: ${label} is not an object`)
  }
  const entries: [string, string][] = []
  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== 'string') throw new Error(`tsdown: ${label}.${key} is not a string`)
    entries.push([key, item])
  }
  return Object.fromEntries(entries)
}

function parseWorkspaceManifest(source: string, label: string): WorkspaceManifest {
  const record = jsonObject(source, label)
  const name = record.name
  if (typeof name !== 'string') throw new Error(`tsdown: ${label} name is not a string`)
  const manifest: {
    name: string
    dependencies?: Readonly<Record<string, string>>
    peerDependencies?: Readonly<Record<string, string>>
    optionalDependencies?: Readonly<Record<string, string>>
    dsh?: { readonly client?: { readonly external?: JsonNode } }
  } = { name }
  const dependencies = stringRecord(record.dependencies, `${label} dependencies`)
  if (dependencies !== undefined) manifest.dependencies = dependencies
  const peerDependencies = stringRecord(record.peerDependencies, `${label} peerDependencies`)
  if (peerDependencies !== undefined) manifest.peerDependencies = peerDependencies
  const optionalDependencies = stringRecord(record.optionalDependencies, `${label} optionalDependencies`)
  if (optionalDependencies !== undefined) manifest.optionalDependencies = optionalDependencies
  const dshNode = record.dsh
  if (dshNode === undefined) return manifest
  if (typeof dshNode !== 'object' || dshNode === null || Array.isArray(dshNode)) {
    throw new Error(`tsdown: ${label} dsh is not an object`)
  }
  const clientNode = dshNode.client
  if (clientNode === undefined) return manifest
  if (typeof clientNode !== 'object' || clientNode === null || Array.isArray(clientNode)) {
    throw new Error(`tsdown: ${label} dsh.client is not an object`)
  }
  const client: { external?: JsonNode } = {}
  if (clientNode.external !== undefined) client.external = clientNode.external
  manifest.dsh = { client }
  return manifest
}

/**
 * Read one workspace package's manifest from an explicit root.
 * Located by package name rather than by cwd. Callers read it on the first
 * resolveId of a build, not while a config is built, so selecting a build face
 * never touches a manifest.
 * @param id - package name, as spelled at the preset call site.
 * @param root - repository root that contains workspace package manifests.
 * @throws {Error} when no workspace package declares that name.
 */
export function workspaceManifestAt(id: string, root: string): WorkspaceManifest {
  for (const manifestPath of globSync(WORKSPACE_PACKAGE_MANIFESTS, { cwd: root })) {
    const label = resolve(root, manifestPath)
    const manifest = parseWorkspaceManifest(readFileSync(label, 'utf8'), label)
    if (manifest.name !== id) continue
    return manifest
  }
  throw new Error(`tsdown: no packages/*/*/package.json declares the name ${id}`)
}
