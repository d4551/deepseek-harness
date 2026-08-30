/**
 * Package registration inventory and batched-model merge.
 */

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import type { CrossFaceLink, FaceModel, PackageModel, TypeDeclarationModel, TypeNodeModel, TypertFace, WorkspaceModel } from './model.ts'
import type { ParsedConfig } from './analyzer-config.ts'
import {
  clientExportSubpaths,
  hostExportSubpaths,
  isDualFacePackage,
  projectConfigPath,
  validatePackageEntrySurface,
} from './analyzer-exports.ts'
import type { PackageRegistration } from './analyzer-types.ts'
import { compareCrossFaceLinks, isWithin, realPath, uniqueBy } from './analyzer-util.ts'
import { readJsoncObject } from './ts7-session.ts'

/**
 * Discover every workspace package both aggregates reference, memoized per
 * root and aggregate pair.
 * @param input - repository root, the two aggregate configs, and the caches to
 *   read parsed configs through and store the inventory in.
 * @returns the registrations, ordered by face and package name.
 */
export function loadRegistrations(input: {
  readonly root: string
  readonly hostConfig: string
  readonly clientConfig: string
  readonly caches: {
    readonly registrations: Map<string, PackageRegistration[]>
    config(path: string): ParsedConfig
  }
}): PackageRegistration[] {
  const inventoryKey = `${input.root}\0${input.hostConfig}\0${input.clientConfig}`
  const cached = input.caches.registrations.get(inventoryKey)
  if (cached !== undefined) return cached
  const registrations: PackageRegistration[] = []
  for (const face of ['host', 'client'] as const) {
    const aggregatePath = resolve(input.root, face === 'host' ? input.hostConfig : input.clientConfig)
    if (!existsSync(aggregatePath)) continue
    const aggregate = input.caches.config(aggregatePath)
    for (const reference of aggregate.projectReferences) {
      const configPath = projectConfigPath(reference.path)
      const packageRoot = dirname(configPath)
      if (!isWithin(realPath(packageRoot), join(input.root, 'packages'))) continue
      const manifest = readJsoncObject(join(packageRoot, 'package.json'))
      if (manifest === undefined) continue
      const name: unknown = Reflect.get(manifest, 'name')
      if (typeof name !== 'string') continue
      validatePackageEntrySurface(manifest, name, realPath(packageRoot))
      const registration: PackageRegistration = {
        face,
        name,
        root: realPath(packageRoot),
        config: input.caches.config(configPath),
        manifest,
      }
      if (!isDualFacePackage(manifest)) {
        registrations.push(registration)
      } else if (configPath === join(packageRoot, 'tsconfig.json')) {
        registrations.push(
          { ...registration, face: 'host', exportSubpaths: hostExportSubpaths(manifest) },
          { ...registration, face: 'client', exportSubpaths: clientExportSubpaths(manifest) },
        )
      } else {
        registrations.push({
          ...registration,
          exportSubpaths: face === 'host'
            ? hostExportSubpaths(manifest)
            : clientExportSubpaths(manifest),
        })
      }
    }
  }
  const inventory = uniqueBy(registrations, registration => `${registration.face}\0${registration.name}`)
    .sort((left, right) =>
      left.face.localeCompare(right.face) || left.name.localeCompare(right.name))
  input.caches.registrations.set(inventoryKey, inventory)
  return inventory
}

/**
 * Combine per-package analyses into one workspace model, merging each face's
 * packages, declarations, and nodes by id.
 * @param models - models to merge; later entries win on an id collision.
 * @returns the merged model with cross-face links deduplicated and ordered.
 */
export function mergeWorkspaceModels(models: readonly WorkspaceModel[]): WorkspaceModel {
  const faces = new Map<TypertFace, {
    packages: Map<string, PackageModel>
    declarations: Map<string, TypeDeclarationModel>
    nodes: Map<string, TypeNodeModel>
  }>()
  const links = new Map<string, CrossFaceLink>()
  for (const model of models) {
    for (const face of model.faces) {
      const merged = faces.get(face.face) ?? {
        packages: new Map(),
        declarations: new Map(),
        nodes: new Map(),
      }
      for (const packageModel of face.packages) merged.packages.set(packageModel.name, packageModel)
      for (const declaration of face.graph.declarations) {
        if (!merged.declarations.has(declaration.id)) merged.declarations.set(declaration.id, declaration)
      }
      for (const node of face.graph.nodes) {
        if (!merged.nodes.has(node.id)) merged.nodes.set(node.id, node)
      }
      faces.set(face.face, merged)
    }
    for (const link of model.crossFaceLinks) {
      links.set([
        link.fromFace,
        link.fromPackage,
        link.toFace,
        link.toPackage,
        link.subpath,
        link.name,
      ].join('\0'), link)
    }
  }
  return {
    faces: [...faces].sort(([left], [right]) =>
      (left === 'host' ? 0 : 1) - (right === 'host' ? 0 : 1)).map(([face, model]): FaceModel => ({
      face,
      packages: [...model.packages.values()].sort((left, right) => left.name.localeCompare(right.name)),
      graph: {
        declarations: [...model.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
        nodes: [...model.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
      },
    })),
    crossFaceLinks: [...links.values()].sort(compareCrossFaceLinks),
  }
}
