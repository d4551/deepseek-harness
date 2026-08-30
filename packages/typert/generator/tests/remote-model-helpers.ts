/**
 * Shared Remote fixture helpers. Consumer typecheck uses a TypeScript 7
 * FaceProject; Host method mapping uses the emitted declaration map.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parse } from 'jsonc-parser'
import type { InvocationModel } from '../src/model.ts'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { generatedSuccess, requiredObject, writeObject } from './type-model-helpers.ts'
import {
  compileDiagnostics,
  definitionAt,
  offsetAt,
  originalPositionFor,
} from './ts7-harness.ts'

export const fixtureRoot = resolve(import.meta.dirname, 'fixtures/remote-model')
export const temporaryRoots: string[] = []

export function normalizedPath(path: string): string {
  return path.replaceAll('\\', '/')
}

export function analyzeRemote(root: string, checkDiagnostics = true): ReturnType<WorkspaceAnalyzer['analyze']> {
  return new WorkspaceAnalyzer({ root, checkDiagnostics }).analyze()
}

export function remotePackage(root: string): {
  readonly services: readonly object[]
  readonly invocations: readonly InvocationModel[]
} {
  const host = analyzeRemote(root).faces.find(face => face.face === 'host')
  const packageModel = host?.packages.find(candidate => candidate.name === '@fixture/remote')
  if (packageModel === undefined) throw new Error('Remote fixture package was not modeled on the host face')
  return packageModel
}

export function copyFixture(sourceRoot = fixtureRoot): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-typert-remote-model-'))
  cpSync(sourceRoot, root, { recursive: true })
  temporaryRoots.push(root)
  return root
}

export function editFile(root: string, relativePath: string, edit: (source: string) => string) {
  const path = join(root, relativePath)
  const source = readFileSync(path, 'utf8')
  const result = edit(source)
  if (result === source) throw new Error(`fixture edit made no change to ${relativePath}`)
  writeFileSync(path, result)
}

export function parseDeclarationMap(text: string): {
  readonly file: string
  readonly names: readonly string[]
  readonly sources: readonly string[]
} {
  const value: unknown = parse(text)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('declaration map is not an object')
  }
  const file: unknown = Reflect.get(value, 'file')
  const names: unknown = Reflect.get(value, 'names')
  const sources: unknown = Reflect.get(value, 'sources')
  if (typeof file !== 'string' || !Array.isArray(names) || !Array.isArray(sources)) {
    throw new Error('declaration map missing file, names, or sources')
  }
  return {
    file,
    names: names.flatMap(item => typeof item === 'string' ? [item] : []),
    sources: sources.flatMap(item => typeof item === 'string' ? [item] : []),
  }
}

export function loadRemoteModule(js: string): Promise<object> {
  const executable = js.replace("from 'zod'", `from ${JSON.stringify(import.meta.resolve('zod'))}`)
  return import(`data:text/javascript,${encodeURIComponent(executable)}`)
}

export async function remoteDescriptors(js: string): Promise<{
  readonly packageName: string
  readonly descriptors: readonly object[]
}> {
  const generated = await loadRemoteModule(js)
  const remote = requiredObject(generated, 'TYPERT_REMOTE')
  const packageName = Reflect.get(remote, 'package')
  const descriptors: unknown = Reflect.get(remote, 'descriptors')
  if (typeof packageName !== 'string' || !isUnknownArray(descriptors)) {
    throw new Error('TYPERT_REMOTE is missing package or descriptors')
  }
  return {
    packageName,
    descriptors: descriptors.flatMap(item => item !== null && typeof item === 'object' ? [item] : []),
  }
}

/** `Array.isArray` widens `unknown` to `any[]`; this keeps the element type. */
function isUnknownArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

export function descriptorBySuffix(descriptors: readonly object[], suffix: string): object {
  const found = descriptors.find((descriptor) => {
    const id: unknown = Reflect.get(descriptor, 'id')
    return typeof id === 'string' && id.endsWith(suffix)
  })
  if (found === undefined) throw new Error(`missing descriptor ${suffix}`)
  return found
}

export function parameterAt(descriptor: object, index: number): object | undefined {
  const parameters: unknown = Reflect.get(descriptor, 'parameters')
  if (!Array.isArray(parameters)) return undefined
  const parameter: unknown = parameters[index]
  if (parameter === null || typeof parameter !== 'object') return undefined
  return parameter
}

export function codecSuccess(parameter: object | undefined, input: boolean | number | string | object | null | undefined): boolean {
  if (parameter === undefined) throw new Error('missing parameter')
  const codec = requiredObject(parameter, 'codec')
  return generatedSuccess(requiredObject(codec, 'schema'), input)
}

export function resultSuccess(descriptor: object, input: boolean | number | string | object | null | undefined): boolean {
  const result = requiredObject(descriptor, 'result')
  return generatedSuccess(requiredObject(result, 'schema'), input)
}

export function assertRemoteConsumerTypechecks(
  dts: string | undefined,
  dtsMap: string | undefined,
  sourceRoot = fixtureRoot,
) {
  if (dts === undefined) throw new Error('Remote fixture emitted no Host-for-Client declaration')
  if (dtsMap === undefined) throw new Error('Remote fixture emitted no Host-for-Client declaration map')
  const consumerRoot = copyFixture(sourceRoot)
  const declarationPath = join(consumerRoot, 'packages/remote/lib/typert.remote-client.d.ts')
  const declarationMapPath = `${declarationPath}.map`
  const consumerPath = join(consumerRoot, 'consumer.ts')
  mkdirSync(join(consumerRoot, 'packages/remote/lib'), { recursive: true })
  writeFileSync(declarationPath, dts)
  writeFileSync(declarationMapPath, dtsMap)
  assertRemoteConsumerWithoutImportHasNoNamespace(consumerRoot)
  const consumerSource = `
import remote from '@fixture/remote/remote'
import type {
  RemoteResult,
  TypertRemoteContribution,
  TypertRemoteScopeMap,
  TypertRemoteMap,
  TypertRemoteNamespaceMap,
} from '@deepseek-ai/dsh-typert-protocol'
import type { CreateGoalResult, RenameGoalResult } from '@fixture/remote/types'

const contribution: TypertRemoteContribution = remote
declare const create: TypertRemoteMap['goals/create']
declare const createScoped: TypertRemoteScopeMap['agent:goals/create']
declare const rename: TypertRemoteScopeMap['agent:goals/rename']
const created: Promise<RemoteResult<CreateGoalResult>> = create('agent-1', { title: 'ship' })
const cancellable: Promise<RemoteResult<CreateGoalResult>> = create('agent-1', { title: 'ship' }, new AbortController().signal)
const createdScoped: Promise<RemoteResult<CreateGoalResult>> = createScoped({ title: 'ship' })
const renamed: Promise<RemoteResult<RenameGoalResult>> = rename({ ref: 'goal-1', title: 'land' })
declare const ctx: { remote: TypertRemoteNamespaceMap }
const navigated: Promise<RemoteResult<CreateGoalResult>> = ctx.remote.goals.create('agent-1', { title: 'navigate' })
export { contribution, created, cancellable, createdScoped, renamed, navigated }
`
  writeFileSync(consumerPath, consumerSource)
  const configPath = join(consumerRoot, 'tsconfig.consumer.json')
  writeObject(configPath, {
    extends: './tsconfig.base.json',
    compilerOptions: {
      composite: false,
      skipLibCheck: false,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./typert-protocol.d.ts'],
        '@fixture/domain/types': ['./packages/domain/src/types.ts'],
        '@fixture/remote/types': ['./packages/remote/src/types.ts'],
        '@fixture/remote/remote': ['./packages/remote/lib/typert.remote-client.d.ts'],
      },
    },
    files: ['./consumer.ts'],
  })
  const diagnostics = compileDiagnostics(configPath)
  expectEmpty(diagnostics)
  const definition = definitionAt(configPath, consumerPath, 'ctx.remote.goals.create')
  assertCreateMapsToHost(definition, dtsMap, declarationPath, consumerRoot)
}

function expectEmpty(diagnostics: readonly { code: number; message: string }[]) {
  if (diagnostics.length === 0) return
  throw new Error(diagnostics.map(diagnostic => diagnostic.message).join('\n'))
}

function assertCreateMapsToHost(
  definition: { fileName: string; start: number; length: number; line: number; character: number },
  dtsMap: string,
  declarationPath: string,
  consumerRoot: string,
) {
  const hostSource = readFileSync(join(consumerRoot, 'packages/remote/src/index.ts'), 'utf8')
  if (normalizedPath(definition.fileName) === normalizedPath(declarationPath)) {
    const mapped = originalPositionFor(dtsMap, definition.line + 1, definition.character)
    if (mapped === undefined) {
      throw new Error('generated Remote definition did not map to its Host source')
    }
    const mappedFile = normalizedPath(resolve(dirname(declarationPath), mapped.source))
    if (!mappedFile.endsWith('/packages/remote/src/index.ts')) {
      throw new Error(`generated Remote definition did not map to its Host source: ${mappedFile}`)
    }
    const pos = offsetAt(hostSource, mapped.line, mapped.column)
    if (hostSource.slice(pos, pos + definition.length) !== 'create') {
      throw new Error(`generated Remote definition did not map to create: ${hostSource.slice(pos, pos + 12)}`)
    }
    return
  }
  if (!normalizedPath(definition.fileName).endsWith('/packages/remote/src/index.ts')) {
    throw new Error(`generated Remote definition did not map to its Host source: ${definition.fileName}`)
  }
  if (hostSource.slice(definition.start, definition.start + definition.length) !== 'create') {
    throw new Error('generated Remote definition did not map to create')
  }
}

function assertRemoteConsumerWithoutImportHasNoNamespace(consumerRoot: string) {
  const consumerPath = join(consumerRoot, 'consumer-without-remote.ts')
  writeFileSync(consumerPath, `
import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
declare const ctx: { remote: TypertRemoteNamespaceMap }
ctx.remote.goals.create('agent-1', { title: 'must not compile' })
`)
  const configPath = join(consumerRoot, 'tsconfig.consumer-without-remote.json')
  writeObject(configPath, {
    extends: './tsconfig.base.json',
    compilerOptions: {
      composite: false,
      skipLibCheck: false,
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./typert-protocol.d.ts'],
      },
    },
    files: ['./consumer-without-remote.ts'],
  })
  const diagnostics = compileDiagnostics(configPath)
  if (diagnostics.length !== 1) {
    throw new Error(`expected one diagnostic, got ${String(diagnostics.length)}: ${diagnostics.map(item => item.message).join('\n')}`)
  }
  const first = diagnostics[0]
  if (first === undefined || first.code !== 2339) {
    throw new Error(`expected TS2339, got ${String(first?.code)}`)
  }
  if (!first.message.includes("Property 'goals' does not exist")) {
    throw new Error(first.message)
  }
}
