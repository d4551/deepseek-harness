/**
 * WorkspaceAnalyzer declaration merge, typeRoots, and registration tests.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

function writeUnreachablePackage(root: string, relative: string, withManifest: boolean) {
  mkdirSync(join(root, relative), { recursive: true })
  writeFileSync(join(root, relative, 'tsconfig.json'), '{}\n')
  if (withManifest) writeFileSync(join(root, relative, 'package.json'), '{}\n')
}

describe('WorkspaceAnalyzer merges', { timeout: 60_000 }, () => {
  it('merges same-name declarations across packages into one model', () => {
    const root = copyFixture('typert-merged-declaration-')
    appendReexport(root, 'Merged', 'interface')

    const merged = new WorkspaceAnalyzer({ root }).analyze().faces
      .flatMap(face => face.graph.declarations)
      .find(declaration => declaration.name === 'Merged')
    expect(merged?.members.map(member => member.name)).toEqual(['left', 'right'])
    expect(merged?.parts?.map(part => part.members.length)).toEqual([1, 1])
    expect(merged?.parts?.map(part => part.typeParameters.length)).toEqual([1, 1])
    expect(merged?.parts?.map(part => part.extends.length)).toEqual([1, 0])
    expect(merged?.parts?.map(part => part.package)).toEqual(['@fixture/host', '@fixture/host'])
  })

  it('merges same-name aliases across packages into one model', () => {
    const root = copyFixture('typert-merged-alias-')
    appendReexport(root, 'MergedInput', 'type')

    const merged = new WorkspaceAnalyzer({ root }).analyze().faces
      .flatMap(face => face.graph.declarations)
      .find(declaration => declaration.name === 'MergedInput')
    expect(merged?.parts?.map(part => part.package)).toEqual(['@fixture/host', '@fixture/host'])
  })

  it('rejects same-name declarations with conflicting shapes', () => {
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

    expectMergeRejection(root)
  })

  it('resolves ambient typeRoots packages through project typeRoots', () => {
    const root = copyFixture('typert-type-roots-')
    enableAmbientTypeRoots(root)

    const targets = new WorkspaceAnalyzer({ root }).analyze().faces
      .flatMap(face => face.graph.nodes)
      .flatMap(node => node.kind === 'reference' ? [node.target] : [])
    expect(targets).toContainEqual({
      kind: 'external',
      module: '@types/node',
      name: 'Process',
    })

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

  it('rejects a host aggregate that references a missing package', () => {
    const root = copyFixture('typert-missing-aggregate-')
    addAggregateReference(root, './packages/missing')

    expectMergeRejection(root)
  })

  it('rejects a client aggregate that references a missing package', () => {
    const root = copyFixture('typert-missing-client-aggregate-')
    const aggregatePath = join(root, 'tsconfig.client.json')
    const aggregate = readObject(aggregatePath)
    Reflect.set(aggregate, 'references', [{ path: './packages/missing' }])
    writeObject(aggregatePath, aggregate)

    expectMergeRejection(root)
  })

  it('rejects a package whose tsconfig extends a missing file', () => {
    const root = copyFixture('typert-missing-extends-')
    const configPath = join(root, 'packages/host/tsconfig.json')
    const config = readObject(configPath)
    setCompilerOption(config, 'extends', './tsconfig.missing.json')
    writeObject(configPath, config)

    expectMergeRejection(root)
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

  it('ignores packages outside the aggregate reference graph', () => {
    const root = copyFixture('typert-registration-filter-')
    writeUnreachablePackage(root, 'outside', false)
    writeUnreachablePackage(root, 'packages/no-manifest', false)
    writeUnreachablePackage(root, 'packages/no-name', true)

    expect(new WorkspaceAnalyzer({ root }).discoverPackages().map(item => item.package))
      .not.toContain('@fixture/host')
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
