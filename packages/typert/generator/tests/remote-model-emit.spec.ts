/**
 * Remote discovery, descriptor emission, codecs, and consumer declarations.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
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
  temporaryRoots,
} from './remote-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Remote model generation', { timeout: 60_000 }, () => {
  it('discovers a Remote-only package and emits strict direct and Context descriptors', async () => {
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
  })

  it('projects authored optionality and absence onto consumers and codecs', async () => {
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
  clear(): undefined {
    return undefined
  }
}

export type {`,
    ))
    const [artifact] = new WorkspaceTypertGenerator(root).generate()
    expect(artifact?.remote?.dts.includes(
      "'goals/maybe': (value: string | undefined) => Promise<RemoteResult<string | undefined>>",
    )).toBe(true)
    expect(artifact?.remote?.dts.includes("'goals/clear': () => Promise<RemoteResult<undefined>>")).toBe(true)
    expect(artifact?.remote?.dts?.includes('value?: string')).toBe(false)
    expect(artifact?.remote?.dts.includes("'goals/labelled': (id: string, label?: string) => Promise<RemoteResult<string>>")).toBe(true)
    const remoteJs = artifact?.remote?.js
    if (remoteJs === undefined) throw new Error('Remote fixture emitted no Host-for-Client JavaScript')
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
  })
})
