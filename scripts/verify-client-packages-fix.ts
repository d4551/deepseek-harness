/**
 * Mechanical manifest repairs for {@link ./verify-client-packages.ts}.
 */

import { globSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { optionalStringRecord } from './manifest-fields.ts'
import { readObjectFile } from './verify-client-packages-facts.ts'
import {
  CORDIS,
  MANIFEST_GLOBS,
  expectedSections,
  isInternalDsh,
  normalizePath,
  packageNameOf,
  rowPackageOf,
  type ClientPackageFacts,
  type ExpectedRule,
  type Manifest,
} from './verify-client-packages-model.ts'

type DependencySection = 'dependencies' | 'peerDependencies' | 'devDependencies'

interface MutableClient {
  external?: string[]
  inject?: string[]
}

interface ManifestDocument {
  readonly path: string
  readonly record: object
  readonly manifest: Manifest
  readonly client: MutableClient | undefined
  changed: boolean
}

function section(manifest: Manifest, field: DependencySection): Record<string, string> {
  return manifest[field] ?? {}
}

function mutableSection(manifest: Manifest, field: DependencySection): Record<string, string> {
  const value = manifest[field]
  if (value !== undefined) return value
  const created: Record<string, string> = {}
  manifest[field] = created
  return created
}

function setDependency(manifest: Manifest, field: DependencySection, name: string, range: string): boolean {
  const dependencies = mutableSection(manifest, field)
  if (dependencies[name] === range) return false
  dependencies[name] = range
  return true
}

function deleteDependency(manifest: Manifest, field: DependencySection, name: string): boolean {
  const dependencies = section(manifest, field)
  if (dependencies[name] === undefined) return false
  manifest[field] = Object.fromEntries(Object.entries(dependencies).filter(([key]) => key !== name))
  return true
}

function deleteEmptySections(manifest: Manifest): boolean {
  let changed = false
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
    if (manifest[field] === undefined || Object.keys(section(manifest, field)).length > 0) continue
    if (field === 'dependencies') delete manifest.dependencies
    else if (field === 'peerDependencies') delete manifest.peerDependencies
    else delete manifest.devDependencies
    changed = true
  }
  return changed
}

function ensureDevOnly(manifest: Manifest, name: string, range: string): boolean {
  let changed = deleteDependency(manifest, 'dependencies', name)
  changed = deleteDependency(manifest, 'peerDependencies', name) || changed
  return setDependency(manifest, 'devDependencies', name, range) || changed
}

function ensureDependencyOnly(manifest: Manifest, name: string, range: string): boolean {
  let changed = deleteDependency(manifest, 'peerDependencies', name)
  changed = deleteDependency(manifest, 'devDependencies', name) || changed
  return setDependency(manifest, 'dependencies', name, range) || changed
}

function ensurePeerDev(manifest: Manifest, name: string, range: string): boolean {
  let changed = deleteDependency(manifest, 'dependencies', name)
  changed = setDependency(manifest, 'peerDependencies', name, range) || changed
  return setDependency(manifest, 'devDependencies', name, range) || changed
}

function preferredRange(
  manifest: Manifest,
  name: string,
  kind: ExpectedRule['kind'],
  inferred: ReadonlyMap<string, ReadonlySet<string>>,
): string | undefined {
  const order: readonly DependencySection[] = kind === 'dependency'
    ? ['dependencies', 'devDependencies', 'peerDependencies']
    : kind === 'dev'
      ? ['devDependencies', 'peerDependencies', 'dependencies']
      : ['peerDependencies', 'devDependencies', 'dependencies']
  for (const field of order) {
    const range = section(manifest, field)[name]
    if (range !== undefined) return range
  }
  if (isInternalDsh(name)) return 'workspace:^'
  const candidates = inferred.get(name)
  return candidates?.size === 1 ? [...candidates][0] : undefined
}

function dependencyRangeCandidates(root: string): Map<string, Set<string>> {
  const candidates = new Map<string, Set<string>>()
  const paths = globSync([
    'package.json',
    ...MANIFEST_GLOBS,
    'website/package.json',
  ], { cwd: root }).map(normalizePath)
  for (const path of new Set(paths)) {
    const manifest: Manifest = {
      dependencies: {},
      peerDependencies: {},
      devDependencies: {},
    }
    const record = readObjectFile(resolve(root, path))
    manifest.dependencies = optionalStringRecord(record, 'dependencies')
    manifest.peerDependencies = optionalStringRecord(record, 'peerDependencies')
    manifest.devDependencies = optionalStringRecord(record, 'devDependencies')
    for (const field of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
      for (const [name, range] of Object.entries(section(manifest, field))) {
        const ranges = candidates.get(name) ?? new Set<string>()
        ranges.add(range)
        candidates.set(name, ranges)
      }
    }
  }
  return candidates
}

function mutableClientOf(record: object): MutableClient | undefined {
  if (!Object.hasOwn(record, 'dsh')) return undefined
  const dsh: unknown = Reflect.get(record, 'dsh')
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh) || !Object.hasOwn(dsh, 'client')) return undefined
  const client: unknown = Reflect.get(dsh, 'client')
  if (client === null || typeof client !== 'object' || Array.isArray(client)) return undefined
  return client
}

function normalizeClientArray(
  client: MutableClient,
  field: 'external' | 'inject',
  remove: (value: string) => boolean,
): boolean {
  const value = client[field]
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) return false
  const seen = new Set<string>()
  const normalized = value.filter((entry) => {
    if (entry === '' || seen.has(entry) || remove(entry)) return false
    seen.add(entry)
    return true
  })
  if (normalized.length === value.length && normalized.every((entry, index) => entry === value[index])) return false
  if (normalized.length === 0) {
    if (field === 'external') delete client.external
    else delete client.inject
  } else {
    client[field] = normalized
  }
  return true
}

function applyDependencyEdits(record: object, manifest: Manifest): void {
  for (const field of ['dependencies', 'peerDependencies', 'devDependencies'] as const) {
    const value = manifest[field]
    if (value === undefined || Object.keys(value).length === 0) {
      if (Object.hasOwn(record, field)) Reflect.deleteProperty(record, field)
    } else {
      Reflect.set(record, field, value)
    }
  }
}

/**
 * Repair manifest declarations whose intended result follows uniquely from the policy.
 * @param root - Absolute repository root.
 * @param facts - Facts used by the verification pass.
 * @returns Repository-relative manifests written by the fixer.
 */
export function fixClientPackageManifests(root: string, facts: ClientPackageFacts): string[] {
  const documents = new Map<string, ManifestDocument>()
  const document = (path: string): ManifestDocument => {
    const cached = documents.get(path)
    if (cached !== undefined) return cached
    const record = readObjectFile(resolve(root, path))
    const rawName: unknown = Reflect.get(record, 'name')
    const loaded: ManifestDocument = {
      path,
      record,
      manifest: {
        ...typeof rawName === 'string' ? { name: rawName } : {},
        dependencies: optionalStringRecord(record, 'dependencies'),
        peerDependencies: optionalStringRecord(record, 'peerDependencies'),
        devDependencies: optionalStringRecord(record, 'devDependencies'),
      },
      client: mutableClientOf(record),
      changed: false,
    }
    documents.set(path, loaded)
    return loaded
  }

  const baseline = new Set([...facts.platformModules, ...facts.preloadedExternals])
  for (const declaration of facts.declarations.filter(entry => entry.dynamic)) {
    const target = document(declaration.manifest)
    const client = target.client
    if (client === undefined) continue
    target.changed = normalizeClientArray(client, 'inject', () => false) || target.changed
    target.changed = normalizeClientArray(
      client,
      'external',
      value => baseline.has(value) || rowPackageOf(value, new Set([declaration.name])) === declaration.name,
    ) || target.changed
  }

  const staticInputs = new Set([
    ...facts.staticLinkedPackages,
    ...facts.platformModules.map(packageNameOf),
  ])
  staticInputs.delete(CORDIS)
  const inferredRanges = dependencyRangeCandidates(root)
  for (const pkg of facts.packages) {
    const target = document(pkg.manifest)
    const expected = expectedSections(pkg, staticInputs)
    for (const [name, rule] of expected) {
      const range = preferredRange(target.manifest, name, rule.kind, inferredRanges)
      if (range === undefined) continue
      target.changed = rule.kind === 'dependency'
        ? ensureDependencyOnly(target.manifest, name, range) || target.changed
        : rule.kind === 'dev'
          ? ensureDevOnly(target.manifest, name, range) || target.changed
          : ensurePeerDev(target.manifest, name, range) || target.changed
    }

    if (pkg.dynamic) {
      const productionNames = new Set([
        ...Object.keys(section(target.manifest, 'dependencies')),
        ...Object.keys(section(target.manifest, 'peerDependencies')),
      ])
      for (const name of productionNames) {
        if (expected.has(name)) continue
        const range = preferredRange(
          target.manifest,
          name,
          staticInputs.has(name) ? 'dev' : 'peer-dev',
          inferredRanges,
        )
        if (range === undefined) continue
        if (staticInputs.has(name)) {
          target.changed = ensureDevOnly(target.manifest, name, range) || target.changed
        } else if (section(target.manifest, 'dependencies')[name] !== undefined && isInternalDsh(name)) {
          target.changed = ensurePeerDev(target.manifest, name, range) || target.changed
        }
      }
    }

    for (const [name, range] of Object.entries(section(target.manifest, 'peerDependencies'))) {
      target.changed = setDependency(target.manifest, 'devDependencies', name, range) || target.changed
    }
    target.changed = deleteEmptySections(target.manifest) || target.changed
    if (target.changed) applyDependencyEdits(target.record, target.manifest)
  }

  const changed = [...documents.values()].filter(target => target.changed).sort((left, right) =>
    left.path.localeCompare(right.path))
  for (const target of changed) {
    writeFileSync(resolve(root, target.path), JSON.stringify(target.record, null, 2) + '\n')
  }
  return changed.map(target => target.path)
}
