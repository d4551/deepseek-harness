/**
 * Shared Remote-model emission case bodies. Each case is registered by
 * remote-model.spec.ts; the split remote-model-*.spec.ts files register the
 * same functions.
 */

import { expect } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readObject, writeObject } from './type-model-helpers.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import {
  assertRemoteConsumerTypechecks,
  codecSuccess,
  copyFixture,
  descriptorBySuffix,
  editFile,
  fixtureRoot,
  parameterAt,
  parseDeclarationMap,
  remoteDescriptors,
  remotePackage,
  resultSuccess,
} from './remote-model-helpers.ts'

export async function discoversRemoteOnlyPackage(): Promise<void> {
  const generator = new WorkspaceTypertGenerator(fixtureRoot)

  expect(generator.discover()).toEqual([{
    package: '@fixture/remote',
    root: 'packages/remote',
    faces: ['host'],
  }])

  const artifacts = generator.generate()
  expect(artifacts).toHaveLength(1)
  const artifact = artifacts[0]
  expect(artifact).toMatchObject({
    package: '@fixture/remote',
    face: 'host',
    packageRoot: 'packages/remote',
  })

  const model = remotePackage(fixtureRoot)
  expect(model.services).toEqual([])
  expect(model.invocations).toHaveLength(3)
  expect(model.invocations[0]).toMatchObject({
    id: '@fixture/remote#goals/create',
    service: 'goals',
    namespace: 'goals',
    method: 'create',
    invocation: { kind: 'direct' },
    scope: { context: 'agent', wire: 'agentId' },
    parameters: [
      {
        name: 'agent',
        wire: 'agentId',
        source: 'lookup',
        lookup: 'agent',
        boundary: { typeSymbol: '@fixture/domain/types#AgentId' },
      },
      {
        name: 'request',
        wire: 'request',
        source: 'json',
        boundary: { typeSymbol: '@fixture/remote/types#CreateGoalRequest' },
      },
    ],
    cancellation: { parameter: 'signal' },
    result: { typeSymbol: '@fixture/remote/types#CreateGoalResult' },
  })
  expect(model.invocations[1]).toMatchObject({
    id: '@fixture/remote#goals/rename',
    service: 'goals',
    namespace: 'goals',
    method: 'rename',
    invocation: {
      kind: 'context',
      context: 'agent',
      wire: 'agentId',
      boundary: { typeSymbol: '@fixture/domain/types#AgentId' },
    },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json',
      boundary: { typeSymbol: '@fixture/remote/types#RenameGoalRequest' },
    }],
    result: { typeSymbol: '@fixture/remote/types#RenameGoalResult' },
  })
  expect(model.invocations[2]).toMatchObject({
    id: '@fixture/remote#goals/watch',
    service: 'goals',
    namespace: 'goals',
    method: 'watch',
    mode: 'stream',
    invocation: { kind: 'direct' },
    parameters: [{
      name: 'agent',
      wire: 'agentId',
      source: 'lookup',
      lookup: 'agent',
    }],
    cancellation: { parameter: 'signal' },
    result: { typeSymbol: '@fixture/remote/types#CreateGoalResult' },
  })

  expect(artifact?.js.includes('invocations: [')).toBe(true)
  expect(artifact?.remote?.dts.includes(
    "'goals/create': (agentId: AgentId, request: CreateGoalRequest, signal?: AbortSignal) => Promise<RemoteResult<CreateGoalResult>>",
  )).toBe(true)
  expect(artifact?.remote?.dts.includes('interface TypertRemoteNamespace$676f616c73 {\n    create:')).toBe(true)
  expect(artifact?.remote?.dts.includes("'goals': TypertRemoteNamespace$676f616c73")).toBe(true)
  expect(artifact?.remote?.dts.includes(
    "'agent:goals/create': (request: CreateGoalRequest, signal?: AbortSignal) => Promise<RemoteResult<CreateGoalResult>>",
  )).toBe(true)
  expect(artifact?.remote?.dts.includes(
    "'agent:goals/rename': (request: RenameGoalRequest) => Promise<RemoteResult<RenameGoalResult>>",
  )).toBe(true)
  expect(artifact?.remote?.dts.includes(
    "'goals/watch': (agentId: AgentId, signal?: AbortSignal) => AsyncIterable<CreateGoalResult>",
  )).toBe(true)

  const remoteJs = artifact?.remote?.js
  if (remoteJs === undefined) throw new Error('Remote fixture emitted no Host-for-Client JavaScript')
  const generated = await remoteDescriptors(remoteJs)
  expect(generated.packageName).toBe('@fixture/remote')
  const create = generated.descriptors[0]
  if (create === undefined) throw new Error('missing create descriptor')
  expect(Reflect.get(create, 'cancellation')).toEqual({ parameter: 'signal' })
  expect(codecSuccess(parameterAt(create, 1), { title: 'ship' })).toBe(true)
  expect(codecSuccess(parameterAt(create, 1), { title: 1 })).toBe(false)
  expect(resultSuccess(create, { ref: 'goal-1' })).toBe(true)
  expect(resultSuccess(create, { ref: 1 })).toBe(false)
  expect(Reflect.get(generated.descriptors[2] ?? {}, 'mode')).toBe('stream')

  const declarationMap = parseDeclarationMap(artifact?.remote?.dtsMap ?? '')
  expect(declarationMap).toMatchObject({
    file: 'typert.remote-client.d.ts',
    sources: ['../src/index.ts'],
  })
  expect(declarationMap.names.includes('create')).toBe(true)

  assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap)
}

export async function projectsAuthoredOptionality(): Promise<void> {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/index.ts', source => source.replace(
    '\n}\n\nexport type {',
    `

  @Remote
  maybe(value: string | undefined): string | undefined {
    return value
  }

  @Remote
  labelled(id: string, label?: string): string {
    return label ?? id
  }

  @Remote
  clear(): void {}
}

export type {`,
  ))

  const [artifact] = new WorkspaceTypertGenerator(root).generate()
  expect(artifact?.remote?.dts.includes(
    "'goals/maybe': (value: string | undefined) => Promise<RemoteResult<string | undefined>>",
  )).toBe(true)
  expect(artifact?.remote?.dts.includes("'goals/clear': () => Promise<RemoteResult<void>>")).toBe(true)
  expect(artifact?.remote?.dts?.includes('value?: string')).toBe(false)
  expect(artifact?.remote?.dts.includes("'goals/labelled': (id: string, label?: string) => Promise<RemoteResult<string>>")).toBe(true)
  const remoteJs = artifact?.remote?.js
  if (remoteJs === undefined) throw new Error('undefined Remote fixture emitted no Host-for-Client JavaScript')
  const generated = await remoteDescriptors(remoteJs)
  const maybe = descriptorBySuffix(generated.descriptors, '/maybe')
  const clear = descriptorBySuffix(generated.descriptors, '/clear')
  expect(Reflect.get(parameterAt(maybe, 0) ?? {}, 'acceptsUndefined')).toBe(true)
  expect(codecSuccess(parameterAt(maybe, 0), undefined)).toBe(true)
  expect(resultSuccess(maybe, undefined)).toBe(true)
  expect(resultSuccess(clear, undefined)).toBe(true)
  expect(resultSuccess(clear, null)).toBe(false)
  const labelled = descriptorBySuffix(generated.descriptors, '/labelled')
  expect(Reflect.get(parameterAt(labelled, 0) ?? {}, 'acceptsUndefined')).toBeUndefined()
  expect(Reflect.get(parameterAt(labelled, 1) ?? {}, 'acceptsUndefined')).toBe(true)
  expect(codecSuccess(parameterAt(labelled, 1), undefined)).toBe(true)
  expect(codecSuccess(parameterAt(labelled, 1), 7)).toBe(false)
}

export async function evaluatesMergedBoundaries(): Promise<void> {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/types.ts', source => `${source}

/** Recursive JSON fixture used by the concrete codec projection. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Merge-extensible operation table represented by concrete fixture entries. */
export interface GenericRemoteMap {
  ship: {
    readonly request: { readonly count: number; readonly meta: Json }
    readonly result: { readonly accepted: boolean }
  }
  cancel: {
    readonly request: { readonly reason: string }
    readonly result: { readonly cancelled: boolean }
  }
}

type GenericRemoteKey = Extract<keyof GenericRemoteMap, string>
type RequestOf<K extends GenericRemoteKey> = GenericRemoteMap[K] extends { readonly request: infer Request }
  ? Request
  : never
type ResultOf<K extends GenericRemoteKey> = GenericRemoteMap[K] extends { readonly result: infer Result }
  ? Result
  : never

/** Strict request union retained in the generated Client declaration. */
export type GenericRequest = {
  [K in GenericRemoteKey]: { readonly kind: K; readonly payload: RequestOf<K> }
}[GenericRemoteKey]

/** Strict result union retained in the generated Client declaration. */
export type GenericResult = {
  [K in GenericRemoteKey]: { readonly kind: K; readonly value: ResultOf<K> }
}[GenericRemoteKey]
`)
  editFile(root, 'packages/remote/src/index.ts', source => source
    .replace(
      '  RenameGoalResult,\n',
      '  RenameGoalResult,\n  GenericRequest,\n  GenericResult,\n  Json,\n',
    )
    .replace(
      "  @Remote({ mode: 'stream' })\n  async *watch",
      `  @Remote
  dispatch(request: GenericRequest): GenericResult {
    if (request.kind === 'ship') return { kind: 'ship', value: { accepted: request.payload.count > 0 } }
    return { kind: 'cancel', value: { cancelled: request.payload.reason.length > 0 } }
  }

  @Remote
  store(value: Json): boolean {
    return value !== null
  }

  @Remote({ mode: 'stream' })
  async *watch`,
    ))

  const [artifact] = new WorkspaceTypertGenerator(root).generate()
  expect(artifact?.remote?.dts.includes(
    "'goals/dispatch': (request: GenericRequest) => Promise<RemoteResult<GenericResult>>",
  )).toBe(true)
  const remoteJs = artifact?.remote?.js
  if (remoteJs === undefined) throw new Error('generic Remote fixture emitted no Host-for-Client JavaScript')
  const generated = await remoteDescriptors(remoteJs)
  const dispatch = descriptorBySuffix(generated.descriptors, '/dispatch')
  expect(codecSuccess(parameterAt(dispatch, 0), { kind: 'ship', payload: { count: 2, meta: { nested: [true, null] } } })).toBe(true)
  expect(codecSuccess(parameterAt(dispatch, 0), { kind: 'ship', payload: { count: '2', meta: {} } })).toBe(false)
  expect(codecSuccess(parameterAt(dispatch, 0), { kind: 'cancel', payload: { reason: 'obsolete' } })).toBe(true)
  expect(codecSuccess(parameterAt(dispatch, 0), { kind: 'unknown', payload: {} })).toBe(false)
  expect(resultSuccess(dispatch, { kind: 'ship', value: { accepted: true } })).toBe(true)
  expect(resultSuccess(dispatch, { kind: 'ship', value: { cancelled: true } })).toBe(false)
  // A boundary typed as the recursive alias itself: the object arm must keep
  // its index signature, or the emitted schema strips every key it receives.
  const store = descriptorBySuffix(generated.descriptors, '/store')
  expect(codecSuccess(parameterAt(store, 0), { nested: { deep: [1, 'two', null] } })).toBe(true)
  expect(codecSuccess(parameterAt(store, 0), { id: 'acme-large' })).toBe(true)
  expect(codecSuccess(parameterAt(store, 0), { bad: undefined })).toBe(false)
  expect(codecSuccess(parameterAt(store, 0), [1, { two: true }])).toBe(true)
  expect(codecSuccess(parameterAt(store, 0), 'plain')).toBe(true)
}

export function importsNestedGenericArguments(): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/types.ts', source => `${source}

/** Generic Remote envelope. */
export interface Box<Value> {
  readonly value: Value
}

/** Payload reachable only as a generic argument. */
export interface BoxPayload {
  readonly count: number
}
`)
  editFile(root, 'packages/remote/src/index.ts', source => source
    .replace(
      '  RenameGoalResult,\n',
      '  RenameGoalResult,\n  Box,\n  BoxPayload,\n',
    )
    .replace(
      "  @Remote({ mode: 'stream' })\n  async *watch",
      `  @Remote
  box(request: Box<BoxPayload>): Box<BoxPayload> {
    return request
  }

  @Remote({ mode: 'stream' })
  async *watch`,
    ))

  const [artifact] = new WorkspaceTypertGenerator(root).generate()
  expect(/import type \{ [^}]*Box[^}]*BoxPayload[^}]* \} from '@fixture\/remote\/types'/.test(artifact?.remote?.dts ?? '')).toBe(true)
  expect(artifact?.remote?.dts.includes('box: (request: Box<BoxPayload>) => Promise<RemoteResult<Box<BoxPayload>>>')).toBe(true)
  assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap, root)
}

export function quotesAliasedMethods(): void {
  const root = copyFixture()
  editFile(root, 'packages/remote/src/index.ts', source => source.replace(
    "  @Remote({ mode: 'stream' })\n  async *watch",
    `  @Remote('create-goal')
  createAlias(request: CreateGoalRequest): CreateGoalResult {
    return { ref: request.title }
  }

  @Remote({ mode: 'stream' })
  async *watch`,
  ))

  const [artifact] = new WorkspaceTypertGenerator(root).generate()
  expect(artifact?.remote?.dts.includes("'create-goal': (request: CreateGoalRequest) => Promise<RemoteResult<CreateGoalResult>>")).toBe(true)
  assertRemoteConsumerTypechecks(artifact?.remote?.dts, artifact?.remote?.dtsMap, root)
}

export function validatesRemoteArtifactsOnHostFaceOnly(): void {
  const root = copyFixture()
  const manifestPath = join(root, 'packages/remote/package.json')
  const manifest = readObject(manifestPath)
  Reflect.set(manifest, 'dsh', { client: {} })
  const exportsField = Reflect.get(manifest, 'exports')
  if (exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    Reflect.set(exportsField, './client', './src/client.ts')
    Reflect.set(exportsField, './client/typert', {
      types: './lib/typert.client.d.ts',
      default: './lib/typert.client.js',
    })
  }
  const files = Reflect.get(manifest, 'files')
  if (Array.isArray(files)) files.push('lib/typert.client.js', 'lib/typert.client.d.ts')
  writeObject(manifestPath, manifest)
  writeObject(join(root, 'tsconfig.client.json'), {
    extends: './tsconfig.base.json',
    files: [],
    references: [{ path: './packages/remote' }],
  })
  writeFileSync(join(root, 'packages/remote/src/client.ts'), `/** @typert schema */
export interface ClientMarker {
  readonly ready: boolean
}
`)
  const artifacts = new WorkspaceTypertGenerator(root).generate()
  expect(artifacts.map(artifact => artifact.face)).toEqual(['host', 'client'])
  expect(artifacts.find(artifact => artifact.face === 'host')?.dts.includes('ClientMarker')).toBe(false)
  expect(artifacts.find(artifact => artifact.face === 'client')?.dts.includes('ClientMarker')).toBe(true)
}
