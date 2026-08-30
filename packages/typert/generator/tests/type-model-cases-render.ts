/**
 * Shared type-model case bodies for TypeGraphRenderer, unscoped external
 * targets, and package export forms. Registered by type-model.spec.ts; the
 * split type-model-*.spec.ts files register the same functions.
 */

import { expect } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { isIdentifier } from 'typescript/unstable/ast/is'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { TypeGraphRenderer } from '../src/renderer.ts'
import {
  copyFixture,
  fixtureRoot,
  readObject,
  setCompilerOption,
  temporaryRoots,
  writeObject,
} from './type-model-helpers.ts'
import {
  canonicalType,
  compileFiles,
  isInterfaceDeclaration,
  isPropertySignatureDeclaration,
  parseOnDisk,
  projectFileNames,
} from './ts7-harness.ts'

export function retainsSyntaxZooTypesThroughRendering(): void {
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
    expect(renderedTypes.get(name), name).toBe(canonicalType(sourceType))
  }
}

export function rendersDeclarationsAsCompilableTypeScript(): void {
  const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
  const root = mkdtempSync(join(import.meta.dirname, '.rendered-model-'))
  temporaryRoots.push(root)
  const externalTypes = join(root, 'external.d.ts')
  writeFileSync(externalTypes, [
    "declare module '@fixture/host' {",
    '  export class Agent<State = unknown> {}',
    '}',
    '',
  ].join('\n'))
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
        'declare class Agent<State = unknown> {}',
        'declare enum AgentPhase {}',
        'declare class HostAgent<State = unknown> {}',
        'declare class HostDefault {}',
        'declare namespace Host { class Agent<State = unknown> {} }',
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
}

export function keepsUnscopedGlobalsAsExternalTargets(): void {
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
  const modelsPath = join(root, 'packages/host/src/models.ts')
  writeFileSync(modelsPath, [
    readFileSync(modelsPath, 'utf8'),
    'export interface SyntaxZoo { readonly unscopedGlobal: UnscopedGlobal }',
    '',
  ].join('\n'))

  const names = projectFileNames(join(root, 'packages/host/tsconfig.json'))
  expect(names.some(name => name.replaceAll('\\', '/').endsWith('/unscoped-global/index.d.ts'))).toBe(true)
  const targets = new WorkspaceAnalyzer({ root }).analyze().faces
    .flatMap(face => face.graph.nodes)
    .flatMap(node => node.kind === 'reference' ? [node.target] : [])
  expect(targets).toContainEqual({
    kind: 'external',
    module: 'unscoped-global',
    subpath: '.',
    name: 'UnscopedGlobal',
  })
}

function hostManifest(root: string): { path: string; value: object } {
  const path = join(root, 'packages/host/package.json')
  return { path, value: readObject(path) }
}

export function acceptsPackageExportForms(): void {
  const root = copyFixture('typert-export-forms-')
  const hostRoot = join(root, 'packages/host')
  writeFileSync(join(hostRoot, 'src/runtime.ts'), 'export interface RuntimeOnly { value: string }\n')
  writeFileSync(join(hostRoot, 'src/direct.ts'), 'export interface Direct { value: string }\n')
  writeFileSync(join(hostRoot, 'src/empty.ts'), '\n')
  const { path, value } = hostManifest(root)
  Reflect.set(value, 'exports', {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './models': { types: './lib/types/models.d.ts', default: './lib/models.js' },
    './array': [null, { browser: './lib/runtime.js' }],
    './fallback': { browser: null, development: './lib/runtime.js' },
    './direct': './src/direct.ts',
    './empty': { types: './lib/types/empty.d.ts' },
    './none': [null, false],
    './empty-conditions': {},
    './package.json': './package.json',
    './typert': './lib/typert.host.js',
    './client/typert': './lib/typert.client.js',
    './wildcard': './lib/*.js',
    './data': './lib/data.json',
    ignored: './lib/index.js',
  })
  writeObject(path, value)
  const exports = new WorkspaceAnalyzer({ root }).analyze().faces
    .find(face => face.face === 'host')?.packages[0]?.exports ?? []
  expect(exports.some(item => item.subpath === './array' && item.name === 'RuntimeOnly')).toBe(true)
  expect(exports.some(item => item.subpath === './fallback' && item.name === 'RuntimeOnly')).toBe(true)
  expect(exports.some(item => item.subpath === './direct' && item.name === 'Direct')).toBe(true)
  expect(exports.some(item => item.subpath === './empty')).toBe(false)

  const variants: readonly { readonly fixture: string; readonly field: string | object; readonly empty: boolean }[] = [
    { fixture: 'typert-export-string-', field: './lib/index.js', empty: false },
    {
      fixture: 'typert-export-conditions-',
      field: { types: './lib/types/index.d.ts', default: './lib/index.js' },
      empty: false,
    },
    { fixture: 'typert-export-array-', field: [null, './lib/index.js'], empty: false },
    { fixture: 'typert-export-empty-', field: {}, empty: true },
  ]
  for (const { fixture, field, empty } of variants) {
    const candidateRoot = copyFixture(fixture)
    const manifest = hostManifest(candidateRoot)
    Reflect.set(manifest.value, 'exports', field)
    writeObject(manifest.path, manifest.value)
    const faces = new WorkspaceAnalyzer({ root: candidateRoot, packages: ['@fixture/host'] }).analyze().faces
    if (empty) {
      expect(faces.flatMap(face => face.packages)).toEqual([])
    } else {
      expect((faces[0]?.packages[0]?.exports.length ?? 0) > 0).toBe(true)
    }
  }

  const typesOnlyRoot = copyFixture('typert-export-types-field-')
  const typesManifest = hostManifest(typesOnlyRoot)
  Reflect.deleteProperty(typesManifest.value, 'exports')
  Reflect.set(typesManifest.value, 'types', './lib/types/index.d.ts')
  writeObject(typesManifest.path, typesManifest.value)
  expect((new WorkspaceAnalyzer({ root: typesOnlyRoot }).analyze().faces[0]?.packages[0]?.exports.length ?? 0) > 0).toBe(true)

  const noneRoot = copyFixture('typert-export-none-')
  const noneManifest = hostManifest(noneRoot)
  Reflect.deleteProperty(noneManifest.value, 'exports')
  Reflect.deleteProperty(noneManifest.value, 'types')
  writeObject(noneManifest.path, noneManifest.value)
  expect(new WorkspaceAnalyzer({ root: noneRoot, packages: ['@fixture/host'] }).analyze().faces
    .flatMap(face => face.packages)).toEqual([])
}
