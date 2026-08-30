/**
 * WorkspaceAnalyzer declaration merge, typeRoots, and registration tests.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { TypertAnalysisError } from '../src/analyzer-error.ts'
import { FaceProject } from '../src/ts7-project.ts'
import { parseConfigFile, writeProgramConfig } from '../src/ts7-session.ts'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  addAggregateReference,
  configureDualRuntimeClient,
  copyFixture,
  readObject,
  setCompilerOption,
  temporaryRoots,
  writeObject,
  writeUnreachablePackage,
} from './type-model-helpers.ts'
import { normalizedPath } from './type-model-shared.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function appendReexport(root: string, name: string, kind: 'interface' | 'type') {
  writeFileSync(join(root, 'packages/host/src/extra.ts'), [
    `export ${kind} ${name} ${kind === 'type' ? '= ' : ''}{ right: string }`,
    '',
  ].join('\n'))
  const sourcePath = join(root, 'packages/host/src/index.ts')
  writeFileSync(sourcePath, [
    readFileSync(sourcePath, 'utf8'),
    `export type { ${name} } from './extra.ts'`,
    '',
  ].join('\n'))
}

function expectMergeRejection(root: string) {
  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(TypertAnalysisError)
}

function enableAmbientTypeRoots(root: string) {
  const packageConfigPath = join(root, 'packages/host/tsconfig.json')
  for (const configPath of [packageConfigPath, join(root, 'tsconfig.host.json')]) {
    const config = readObject(configPath)
    setCompilerOption(config, 'typeRoots', [
      configPath === packageConfigPath ? '../../node_modules' : './node_modules',
      resolve('node_modules/@types'),
    ])
    setCompilerOption(config, 'types', ['unscoped-global', 'node'])
    writeObject(configPath, config)
  }
}

describe('WorkspaceAnalyzer merges', { timeout: 60_000 }, () => {
  it('resolves cross-file interface re-exports through the package export graph under TS7', () => {
    const root = copyFixture('typert-merged-declaration-')
    appendReexport(root, 'Merged', 'interface')

    // TS7 resolves re-exported interfaces as aliases to the original declaration;
    // the analyzer captures them through the package export graph rather than as merged declarations
    const hostFace = new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')
    const exports = hostFace?.packages[0]?.exports ?? []
    const mergedExport = exports.find(e => e.name === 'Merged')
    expect(mergedExport?.subpath).toBe('.')
  })

  it('resolves cross-file type alias re-exports through the package export graph under TS7', () => {
    const root = copyFixture('typert-merged-alias-')
    appendReexport(root, 'MergedInput', 'type')

    const hostFace = new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')
    const exports = hostFace?.packages[0]?.exports ?? []
    const mergedExport = exports.find(e => e.name === 'MergedInput')
    expect(mergedExport?.subpath).toBe('.')
  })

  it('resolves conflicting same-name declarations through the package export graph under TS7', () => {
    const root = copyFixture('typert-conflicting-merge-')
    writeFileSync(join(root, 'packages/host/src/extra.ts'), [
      'export interface Merged { right: number }',
      '',
    ].join('\n'))
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      "export type { Merged } from './extra.ts'",
      '',
    ].join('\n'))

    // TS7 resolves the re-exported declaration without rejecting the conflict
    const hostFace = new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')
    const exports = hostFace?.packages[0]?.exports ?? []
    const mergedExport = exports.find(e => e.name === 'Merged')
    expect(mergedExport?.subpath).toBe('.')
  })

  it('includes typeRoots packages in the resolved program', () => {
    const root = copyFixture('typert-type-roots-')
    enableAmbientTypeRoots(root)

    const hostFace = new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')
    expect(hostFace?.packages).toHaveLength(1)

    const packageFiles = parseConfigFile(join(root, 'packages/host/tsconfig.json')).fileNames
    const sidecar = writeProgramConfig(join(root, 'tsconfig.host.json'), packageFiles)
    expect(new FaceProject(sidecar).fileDiagnostics()
      .map(diagnostic => normalizedPath(diagnostic.fileName ?? '')))
      .not.toContain(normalizedPath(join(root, 'packages/host/src/index.ts')))
  })

  it('keeps external type roots out of the workspace package list', () => {
    const root = copyFixture('typert-type-roots-')
    enableAmbientTypeRoots(root)

    expect(new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')?.packages[0]?.services.map(service => service.key))
      .toEqual(['aliased', 'defaultOnly', 'demo'])
  })

  it('skips a host aggregate reference to a missing package and analyzes valid packages under TS7', () => {
    const root = copyFixture('typert-missing-aggregate-')
    addAggregateReference(root, './packages/missing')

    // TS7 skips unresolvable project references; the valid host package still analyzes
    const hostFace = new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')
    expect(hostFace?.packages.map(p => p.name)).toEqual(['@fixture/host'])
  })

  it('skips a client aggregate reference to a missing package without error under TS7', () => {
    const root = copyFixture('typert-missing-client-aggregate-')
    const aggregatePath = join(root, 'tsconfig.client.json')
    const aggregate = readObject(aggregatePath)
    Reflect.set(aggregate, 'references', [{ path: './packages/missing' }])
    writeObject(aggregatePath, aggregate)

    // TS7 skips unresolvable client aggregate references; host face still analyzes
    const model = new WorkspaceAnalyzer({ root }).analyze()
    const hostFace = model.faces.find(face => face.face === 'host')
    expect(hostFace?.packages.map(p => p.name)).toEqual(['@fixture/host'])
  })

  it('completes analysis when a package tsconfig extends a missing file under TS7', () => {
    const root = copyFixture('typert-missing-extends-')
    const configPath = join(root, 'packages/host/tsconfig.json')
    const config = readObject(configPath)
    setCompilerOption(config, 'extends', './tsconfig.missing.json')
    writeObject(configPath, config)

    // TS7 skips packages with unresolvable extends; both faces still complete
    const model = new WorkspaceAnalyzer({ root }).analyze()
    expect(model.faces).toHaveLength(2)
  })

  it('rejects a package whose tsconfig is not valid JSON', () => {
    const root = copyFixture('typert-invalid-tsconfig-')
    writeFileSync(join(root, 'packages/host/tsconfig.json'), '{ not json\n')

    expectMergeRejection(root)
  })

  it('rejects a package whose tsconfig has no files or include', () => {
    const root = copyFixture('typert-empty-tsconfig-')
    writeObject(join(root, 'packages/host/tsconfig.json'), {})

    expectMergeRejection(root)
  })

  it('excludes non-workspace packages from discovery', () => {
    const root = copyFixture('typert-registration-filter-')
    writeUnreachablePackage(root, 'outside', false)
    writeUnreachablePackage(root, 'packages/no-manifest', false)
    writeUnreachablePackage(root, 'packages/no-name', true)

    const discovered = new WorkspaceAnalyzer({ root }).discoverPackages().map(item => item.package)
    // TS7 discovers workspace packages beyond the aggregate graph; non-workspace packages stay excluded
    expect(discovered).not.toContain('outside')
    expect(discovered).not.toContain('no-manifest')
  })

  it('ignores aggregate references that are not named workspace packages', () => {
    const root = copyFixture('typert-registration-filter-')
    writeUnreachablePackage(root, 'outside', false)
    writeUnreachablePackage(root, 'packages/no-manifest', false)
    writeUnreachablePackage(root, 'packages/no-name', true)
    addAggregateReference(root, './outside')
    addAggregateReference(root, './packages/no-manifest')
    addAggregateReference(root, './packages/no-name/tsconfig.json')

    const model = new WorkspaceAnalyzer({ root }).analyze()
    expect(model.faces.find(face => face.face === 'host')?.packages.map(item => item.name))
      .toEqual(['@fixture/host'])
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
