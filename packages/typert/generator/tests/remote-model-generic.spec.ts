/**
 * Mapped and conditional Remote codecs, nested generic imports, and aliases.
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
  parameterAt,
  remoteDescriptors,
  resultSuccess,
  temporaryRoots,
} from './remote-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Remote generic and alias emission', { timeout: 60_000 }, () => {
  it('evaluates declaration-merged mapped and conditional boundaries for codecs without widening consumer types', async () => {
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
        '  RenameGoalResult,\n  GenericRequest,\n  GenericResult,\n',
      )
      .replace(
        "  @Remote({ mode: 'stream' })\n  async *watch",
        `  @Remote
  dispatch(request: GenericRequest): GenericResult {
    if (request.kind === 'ship') return { kind: 'ship', value: { accepted: request.payload.count > 0 } }
    return { kind: 'cancel', value: { cancelled: request.payload.reason.length > 0 } }
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
    expect(codecSuccess(parameterAt(dispatch, 0), { kind: 'nope', payload: {} })).toBe(false)
    expect(resultSuccess(dispatch, { kind: 'ship', value: { accepted: true } })).toBe(true)
    expect(resultSuccess(dispatch, { kind: 'ship', value: { cancelled: true } })).toBe(false)
  })

  it('imports public type arguments nested under a named generic boundary', () => {
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
  })

  it('quotes aliased methods in generated namespace interfaces', () => {
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
  })
})
