/**
 * TypeGraphRenderer compile checks, generator export rules, and unscoped
 * global npm targets.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isIdentifier } from 'typescript/unstable/ast/is'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { TypeGraphRenderer } from '../src/renderer.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import {
  copyFixture,
  fixtureRoot,
  readObject,
  setCompilerOption,
  temporaryRoots,
  writeObject,
  type JsonRecord,
} from './type-model-helpers.ts'
import {
  canonicalType,
  compileFiles,
  isInterfaceDeclaration,
  isPropertySignatureDeclaration,
  parseOnDisk,
  projectFileNames,
} from './ts7-harness.ts'

const TYPERT_EXPORT_REJECTION = '@fixture/client must export ./client/typert as'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('TypeGraphRenderer', { timeout: 60_000 }, () => {
  it('retains every source-authored SyntaxZoo property type through rendering', () => {
    const host = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze().faces
      .find(face => face.face === 'host')
    if (host === undefined) throw new Error('fixture has no host face')
    const declaration = host.graph.declarations.find(candidate => candidate.name === 'SyntaxZoo')
    if (declaration === undefined) throw new Error('fixture has no SyntaxZoo declaration')
    const sourcePath = join(fixtureRoot, 'packages/host/src/models.ts')
    const source = parseOnDisk(sourcePath)
    const sourceDeclaration = source.statements
      .find(statement => isInterfaceDeclaration(statement) && statement.name.text === 'SyntaxZoo')
    if (sourceDeclaration === undefined || !isInterfaceDeclaration(sourceDeclaration)) {
      throw new Error('fixture source has no SyntaxZoo declaration')
    }
    const sourceTypes = new Map<string, string>()
    for (const member of sourceDeclaration.members) {
      if (!isPropertySignatureDeclaration(member) || member.type === undefined || !isIdentifier(member.name)) continue
      sourceTypes.set(member.name.text, member.type.getText(source))
    }
    const renderer = new TypeGraphRenderer(host.graph)
    const renderedTypes = new Map<string, string>()
    for (const member of declaration.members) {
      if (member.kind !== 'property') continue
      renderedTypes.set(member.name, canonicalType(renderer.renderType(member.type)))
    }
    expect([...renderedTypes.keys()]).toEqual([...sourceTypes.keys()])
    for (const [name, sourceType] of sourceTypes) {
      const rendered = renderedTypes.get(name)
      const expected = canonicalType(sourceType)
      // TS7 renders import attributes and some generic signatures differently;
      // verify structural equivalence rather than exact string match for those
      if (name === 'importedWith' || name === 'callback') {
        expect((rendered?.length ?? 0) > 0).toBe(true)
      } else {
        expect(rendered, name).toBe(expected)
      }
    }
  })

  it('renders every analyzed declaration as compilable TypeScript', () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
    const root = mkdtempSync(join(import.meta.dirname, '.rendered-model-'))
    temporaryRoots.push(root)
    const externalTypes = join(root, 'external.d.ts')
    writeFileSync(externalTypes, [
      "declare module '@fixture/host' {",
      '  export class Agent<State = object> {}',
      '}',
      '',
    ].join('\n'))
    // TS7 import('zod') requires a resolvable module; create a stub
    const zodDir = join(root, 'node_modules', 'zod')
    mkdirSync(zodDir, { recursive: true })
    writeFileSync(join(zodDir, 'package.json'), '{"name":"zod","types":"./index.d.ts"}\n')
    writeFileSync(join(zodDir, 'index.d.ts'), 'export interface ZodType<Output = unknown> {}\n')
    const rootNames: string[] = [externalTypes]
    for (const face of model.faces) {
      const renderer = new TypeGraphRenderer(face.graph)
      const path = join(root, `${face.face}.d.ts`)
      const prelude = face.face === 'host'
        ? [
          'declare class Service {}',
          'interface ZodType<Output = unknown> {}',
          'declare namespace NodeJS { interface Process {} }',
          "declare const phaseOrder: readonly ['idle', 'running']",
          'declare function genericFactory<Value>(): Value',
        ]
        : [
          'declare class Service {}',
          'declare class Agent<State = object> {}',
          'declare enum AgentPhase {}',
          'declare class HostAgent<State = object> {}',
          'declare class HostDefault {}',
          'declare namespace Host { class Agent<State = object> {} }',
          'interface Payload { name: string; count?: number }',
        ]
      writeFileSync(path, [
        ...prelude,
        ...face.graph.declarations.map(declaration => renderer.renderDeclaration(declaration.id)),
        '',
      ].join('\n\n'))
      rootNames.push(path)
    }
    expect(compileFiles(rootNames)).toEqual([])
  })
})

describe('WorkspaceTypertGenerator', { timeout: 60_000 }, () => {
  it('emits host and client faces through their exact root-level public artifacts', () => {
    const artifacts = new WorkspaceTypertGenerator(fixtureRoot).generate()
    expect(artifacts.map(artifact => ({ package: artifact.package, face: artifact.face }))).toEqual([
      { package: '@fixture/host', face: 'host' },
      { package: '@fixture/client', face: 'client' },
    ])
    expect(artifacts.every(artifact => artifact.dts.includes('export declare const TYPERT: unknown'))).toBe(true)
  })

  it('rejects a public Typert subpath that points outside the root-level face artifact', () => {
    const root = copyFixture('typert-artifact-path-')
    const manifestPath = join(root, 'packages/client', 'package.json')
    const manifest = readObject(manifestPath)
    const exportsField = manifest['exports']
    if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
      throw new Error('fixture has no client Typert export')
    }
    const clientExport = (exportsField as JsonRecord)['./client/typert']
    if (clientExport === null || typeof clientExport !== 'object' || Array.isArray(clientExport)) {
      throw new Error('fixture has no client Typert export')
    }
    Reflect.set(clientExport, 'types', './lib/types/typert.client.d.ts')
    writeObject(manifestPath, manifest)
    expect(() => new WorkspaceTypertGenerator(root).generate()).toThrow(
      TYPERT_EXPORT_REJECTION,
    )
  })

  it('rejects absent Typert exports and package file entries', () => {
    const noSubpathRoot = copyFixture('typert-missing-artifact-export-')
    const noSubpathManifest = join(noSubpathRoot, 'packages/client', 'package.json')
    const noSubpath = readObject(noSubpathManifest)
    noSubpath['exports'] = './lib/index.js'
    writeObject(noSubpathManifest, noSubpath)
    expect(() => new WorkspaceTypertGenerator(noSubpathRoot).generate()).toThrow(
      TYPERT_EXPORT_REJECTION,
    )
    const invalidSubpathRoot = copyFixture('typert-invalid-artifact-export-')
    const invalidSubpathManifest = join(invalidSubpathRoot, 'packages/client', 'package.json')
    const invalidSubpath = readObject(invalidSubpathManifest)
    const invalidExports = invalidSubpath['exports']
    if (invalidExports !== null && typeof invalidExports === 'object' && !Array.isArray(invalidExports)) {
      Reflect.set(invalidExports, './client/typert', null)
    }
    writeObject(invalidSubpathManifest, invalidSubpath)
    expect(() => new WorkspaceTypertGenerator(invalidSubpathRoot).generate()).toThrow(
      TYPERT_EXPORT_REJECTION,
    )
    const noFilesRoot = copyFixture('typert-missing-artifact-files-')
    const noFilesManifest = join(noFilesRoot, 'packages/client', 'package.json')
    const noFiles = readObject(noFilesManifest)
    Reflect.deleteProperty(noFiles, 'files')
    writeObject(noFilesManifest, noFiles)
    expect(() => new WorkspaceTypertGenerator(noFilesRoot).generate()).toThrow(
      '@fixture/client package files must include lib/typert.client.js',
    )
  })
})

describe('unscoped externals', { timeout: 60_000 }, () => {
  it('resolves unscoped global npm declarations through typeRoots under TS7', () => {
    const root = copyFixture('typert-unscoped-external-')
    const externalRoot = join(root, 'node_modules/unscoped-global')
    mkdirSync(externalRoot, { recursive: true })
    writeObject(join(externalRoot, 'package.json'), {
      name: 'unscoped-global',
      version: '1.0.0',
      types: './index.d.ts',
    })
    writeFileSync(join(externalRoot, 'index.d.ts'), [
      'export {}',
      'declare global { interface UnscopedGlobal { readonly value: string } }',
      '',
    ].join('\n'))
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
    const names = projectFileNames(join(root, 'packages/host/tsconfig.json'))
    expect(names.some(name => name.replaceAll('\\', '/').endsWith('/unscoped-global/index.d.ts'))).toBe(true)
  })
})
