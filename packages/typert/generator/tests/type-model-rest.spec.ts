/**
 * Remaining WorkspaceAnalyzer tests from the original type-model spec.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TypertAnalysisError } from '../src/analyzer-error.ts'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  configureDualRuntimeClient,
  copyFixture,
  fixtureRoot,
  readObject,
  temporaryRoots,
  writeObject,
} from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceAnalyzer remaining cases', { timeout: 60_000 }, () => {
  it('skips ambient imports without physical module files while walking exported sources', () => {
    const root = copyFixture('typert-ambient-import-')
    const declarationsPath = join(root, 'cordis.d.ts')
    writeFileSync(declarationsPath, [readFileSync(declarationsPath, 'utf8'), "declare module 'fixture-ambient' {}", ''].join('\n'))
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, ["import 'fixture-ambient'", readFileSync(sourcePath, 'utf8')].join('\n'))
    expect(new WorkspaceAnalyzer({ root }).analyze().faces
      .find(face => face.face === 'host')?.packages[0]?.services.map(service => service.key))
      .toContain('demo')
  })

  it('rejects declaration merges without a lossless model', () => {
    const root = copyFixture('typert-merged-enum-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [readFileSync(sourcePath, 'utf8'), '/** @typert schema */', "export enum MergedEnum { Left = 'left' }", "export enum MergedEnum { Right = 'right' }", ''].join('\n'))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'merged EnumDeclaration declaration MergedEnum is not supported',
    )
  })

  it('rejects merged interfaces with conflicting authored variance', () => {
    const root = copyFixture('typert-merged-variance-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [readFileSync(sourcePath, 'utf8'), '/** @typert object */', 'export interface MergedVariance<in Value> { consume(value: Value): void }', 'export interface MergedVariance<out Value> { produce(): Value }', ''].join('\n'))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'merged interface MergedVariance has incompatible variance modifiers',
    )
  })

  it('handles empty selections and rejects malformed aggregate configs', () => {
    const empty = mkdtempSync(join(import.meta.dirname, '.typert-empty-workspace-'))
    temporaryRoots.push(empty)
    expect(new WorkspaceAnalyzer({ root: empty }).analyze()).toEqual({ faces: [], crossFaceLinks: [] })
    writeFileSync(join(empty, 'empty.d.ts'), 'export {}\n')
    writeFileSync(join(empty, 'tsconfig.host.json'), '{ "files": ["empty.d.ts"] }\n')
    expect(new WorkspaceAnalyzer({ root: empty }).analyze()).toEqual({ faces: [], crossFaceLinks: [] })
    writeFileSync(join(empty, 'tsconfig.host.json'), '{ invalid json')
    expect(() => new WorkspaceAnalyzer({ root: empty }).analyze()).toThrow(TypertAnalysisError)
    writeObject(join(empty, 'tsconfig.host.json'), { compilerOptions: { target: 'invalid' } })
    expect(() => new WorkspaceAnalyzer({ root: empty }).analyze()).toThrow(TypertAnalysisError)
    expect(new WorkspaceAnalyzer({ root: fixtureRoot, packages: ['@fixture/absent'] }).analyze())
      .toEqual({ faces: [], crossFaceLinks: [] })
  })

  it('ignores empty Cordis augmentations during package discovery', () => {
    const root = copyFixture('typert-empty-augmentation-')
    const hostRoot = join(root, 'packages/host')
    const manifest = readObject(join(hostRoot, 'package.json'))
    Reflect.set(manifest, 'exports', {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
    })
    writeObject(join(hostRoot, 'package.json'), manifest)
    writeFileSync(join(hostRoot, 'src/index.ts'), [
      'export {}',
      "declare module '@deepseek-ai/cordis' {",
      '  interface Context {}',
      '  interface Events {}',
      '  interface Ignored {}',
      '}',
      '',
    ].join('\n'))
    expect(new WorkspaceAnalyzer({ root }).discoverPackages().map(item => item.package))
      .not.toContain('@fixture/host')
  })

  it('ignores aggregate references that are not named workspace packages', () => {
    const root = copyFixture('typert-registration-filter-')
    mkdirSync(join(root, 'outside'), { recursive: true })
    writeFileSync(join(root, 'outside/tsconfig.json'), '{}\n')
    mkdirSync(join(root, 'packages/no-manifest'), { recursive: true })
    writeFileSync(join(root, 'packages/no-manifest/tsconfig.json'), '{}\n')
    mkdirSync(join(root, 'packages/no-name'), { recursive: true })
    writeFileSync(join(root, 'packages/no-name/tsconfig.json'), '{}\n')
    writeFileSync(join(root, 'packages/no-name/package.json'), '{}\n')
    const aggregatePath = join(root, 'tsconfig.host.json')
    const aggregate = readObject(aggregatePath)
    const refs = Reflect.get(aggregate, 'references')
    if (Array.isArray(refs)) {
      refs.push({ path: './outside' }, { path: './packages/no-manifest' }, { path: './packages/no-name/tsconfig.json' })
    }
    writeObject(aggregatePath, aggregate)
    expect(new WorkspaceAnalyzer({ root }).analyze().faces.find(face => face.face === 'host')?.packages.map(item => item.name))
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
      .filter(declaration => declaration.package === '@fixture/client' && declaration.name.endsWith('OnlyMarker'))
      .map(declaration => ({ face: declaration.face, name: declaration.name }))
    expect(markers).toEqual([
      { face: 'client', name: 'ClientOnlyMarker' },
      { face: 'host', name: 'HostOnlyMarker' },
    ])
  })

  it('rejects package exports whose source entry is missing', () => {
    const root = copyFixture('typert-missing-export-source-')
    const manifestPath = join(root, 'packages/host/package.json')
    const manifest = readObject(manifestPath)
    Reflect.set(manifest, 'exports', { '.': './lib/missing.js' })
    writeObject(manifestPath, manifest)
    expect(() => new WorkspaceAnalyzer({ root, packages: ['@fixture/host'] }).analyze())
      .toThrow('resolves to missing source')
  })

  it('recognizes all supported typert annotation spellings', () => {
    const root = copyFixture('typert-annotation-modes-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert */',
      'export interface DefaultSchema { value: string }',
      '/** @typert type */',
      'export interface TypeSchema { value: string }',
      '/** @typert ignored */',
      'export interface IgnoredSchema { value: string }',
      '',
    ].join('\n'))
    const host = new WorkspaceAnalyzer({ root }).analyze().faces.find(face => face.face === 'host')
    expect(host?.packages[0]?.schemas.map(schema => schema.export.name))
      .toEqual(expect.arrayContaining(['DefaultSchema', 'Payload', 'TypeSchema']))
    expect(host?.packages[0]?.schemas.map(schema => schema.export.name)).not.toContain('IgnoredSchema')
  })

  it('rejects an exported Context service that is not a class or interface', () => {
    const root = copyFixture('typert-invalid-service-')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8')
      .replace(
        "export { AgentPhase } from './models.ts'",
        "export { AgentPhase } from './models.ts'\nexport type InvalidService = { value: string }",
      )
      .replace('    demo: DemoService', '    demo: DemoService\n    invalidService: InvalidService'))
    expect(() => new WorkspaceAnalyzer({ root }).analyze())
      .toThrow('does not resolve to an exported class or interface')
  })

  it('rejects tagged anonymous declarations that cannot be named losslessly', () => {
    const root = copyFixture('typert-anonymous-declaration-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert object */',
      'export default class { readonly value: string = "value" }',
      '',
    ].join('\n'))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'anonymous ClassDeclaration cannot be represented as a named type declaration',
    )
  })

  it('retains merged generic interfaces without constraints or defaults', () => {
    const root = copyFixture('typert-plain-merged-interface-')
    const sourcePath = join(root, 'packages/host/src/models.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert object */',
      'export interface PlainMerged<Value> { left: Value }',
      'export interface PlainMerged<Value> { right: Value }',
      '',
    ].join('\n'))
    const declaration = new WorkspaceAnalyzer({ root }).analyze().faces
      .flatMap(face => face.graph.declarations)
      .find(item => item.name === 'PlainMerged')
    expect(declaration?.typeParameters).toEqual([expect.objectContaining({ name: 'Value', const: false })])
    expect(declaration?.typeParameters[0]).not.toHaveProperty('constraint')
    expect(declaration?.typeParameters[0]).not.toHaveProperty('default')
  })
})
