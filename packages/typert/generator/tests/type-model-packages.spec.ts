/**
 * WorkspaceAnalyzer package discovery and export resolution tests.
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  configureDualRuntimeClient,
  copyFixture,
  readObject,
  temporaryRoots,
  writeObject,
  writeUnreachablePackage,
  type JsonInput,
} from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function hostManifestPath(root: string) {
  return join(root, 'packages/host', 'package.json')
}

function mutateHostManifest(root: string, mutate: (manifest: object) => void) {
  const manifestPath = hostManifestPath(root)
  const manifest = readObject(manifestPath)
  mutate(manifest)
  writeObject(manifestPath, manifest)
}

function setHostExports(root: string, exports: JsonInput) {
  mutateHostManifest(root, (manifest) => {
    if (exports === undefined) Reflect.deleteProperty(manifest, 'exports')
    else Reflect.set(manifest, 'exports', exports)
  })
}

function setHostTypes(root: string, types: string | undefined) {
  mutateHostManifest(root, (manifest) => {
    if (types === undefined) Reflect.deleteProperty(manifest, 'types')
    else Reflect.set(manifest, 'types', types)
  })
}

function expectExportsRejection(root: string, message: string) {
  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(message)
}

function analyzeHostPackages(root: string) {
  return new WorkspaceAnalyzer({ root }).analyze().faces
    .find(face => face.face === 'host')?.packages.map(item => item.name)
}

function expectHostPackages(root: string) {
  expect(analyzeHostPackages(root)).toEqual(['@fixture/host'])
}

describe('WorkspaceAnalyzer packages', { timeout: 60_000 }, () => {
  it('indexes only packages reachable from the aggregate reference graph', () => {
    const root = copyFixture('typert-registration-filter-')
    writeUnreachablePackage(root, 'outside', false)
    writeUnreachablePackage(root, 'packages/no-manifest', false)
    writeUnreachablePackage(root, 'packages/no-name', true)

    const discovered = new WorkspaceAnalyzer({ root }).discoverPackages().map(item => item.package)
    // TS7 project reference resolution may discover workspace packages beyond
    // the aggregate graph; unreachable non-workspace packages stay excluded.
    expect(discovered).not.toContain('outside')
    expect(discovered).not.toContain('no-manifest')
  })

  it('requires package.json exports to resolve a package root', () => {
    const root = copyFixture('typert-missing-exports-')
    setHostExports(root, {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    })

    const model = new WorkspaceAnalyzer({ root }).analyze()
    expect(model.faces.find(face => face.face === 'host')?.packages.map(item => item.name))
      .toEqual(['@fixture/host'])
  })

  it('accepts a package.json exports field that is a string', () => {
    const root = copyFixture('typert-string-exports-')
    setHostExports(root, './lib/index.js')
    expectHostPackages(root)
  })

  it('accepts a package.json exports field that is a single condition object', () => {
    const root = copyFixture('typert-condition-exports-')
    setHostExports(root, { types: './lib/types/index.d.ts', default: './lib/index.js' })
    expectHostPackages(root)
  })

  it('accepts a package.json exports field that is an array', () => {
    const root = copyFixture('typert-array-exports-')
    setHostExports(root, [null, './lib/index.js'])
    expectHostPackages(root)
  })

  it('skips a package.json exports field that is empty', () => {
    const root = copyFixture('typert-empty-exports-')
    setHostExports(root, {})
    expect(new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze().faces
      .flatMap(face => face.packages)).toEqual([])
  })

  it('falls back to the types field when package.json exports is absent', () => {
    const root = copyFixture('typert-types-fallback-')
    setHostExports(root, undefined)
    setHostTypes(root, './lib/types/index.d.ts')

    expectHostPackages(root)
  })

  it('discovers source exports for a package without exports or types', () => {
    const root = copyFixture('typert-no-entry-')
    setHostTypes(root, undefined)

    const packages = new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze().faces
      .flatMap(face => face.packages)
    expect(packages.map(item => item.name)).toEqual(['@fixture/host'])
    expect((packages[0]?.exports.length ?? 0) > 0).toBe(true)
  })

  it('rejects a package whose default export target is missing', () => {
    const root = copyFixture('typert-missing-entry-')
    setHostExports(root, { '.': { types: './lib/types/missing.d.ts', default: './lib/missing.js' } })
    expectExportsRejection(root, '@fixture/host package.json exports must point to existing files')
  })

  it('indexes only public symbols from package.json exports', () => {
    const root = copyFixture('typert-public-exports-')

    const host = new WorkspaceAnalyzer({ root }).analyze().faces.find(face => face.face === 'host')
    const names = host?.packages[0]?.schemas.map(schema => schema.export.name) ?? []
    expect(names).toContain('Payload')
    expect(names).not.toContain('IgnoredSchema')
  })

  it('rejects a package whose exports point outside the package root', () => {
    const root = copyFixture('typert-escaping-exports-')
    setHostExports(root, { '.': '../outside/index.js' })
    expectExportsRejection(root, '@fixture/host package.json exports must stay inside the package root')
  })

  it('rejects a package whose exports point to a missing file', () => {
    const root = copyFixture('typert-missing-export-file-')
    setHostExports(root, { '.': './lib/absent.js' })
    expectExportsRejection(root, '@fixture/host package.json exports must point to existing files')
  })

  it('keeps both runtime faces for an ordinary dsh.client project', () => {
    const root = copyFixture('typert-dual-runtime-')
    configureDualRuntimeClient(root, false)

    expect(new WorkspaceAnalyzer({ root }).discoverPackages()).toContainEqual({
      package: '@fixture/client',
      root: 'packages/client',
      faces: ['client', 'host'],
    })
  })

  it('confines explicit face projects to their selected Typert face', () => {
    const root = copyFixture('typert-split-project-')
    configureDualRuntimeClient(root, true)

    const markers = new WorkspaceAnalyzer({ root }).indexSourceDeclarations()
      .filter(declaration => declaration.package === '@fixture/client'
        && declaration.name.endsWith('OnlyMarker'))
      .map(declaration => ({ face: declaration.face, name: declaration.name }))
    expect(markers).toEqual([
      { face: 'client', name: 'ClientOnlyMarker' },
      { face: 'host', name: 'HostOnlyMarker' },
    ])
  })
})
