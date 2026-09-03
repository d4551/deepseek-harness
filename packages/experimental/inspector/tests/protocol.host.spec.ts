/** Worker and shared protocol behavior. */

import { describe, expect, it, vi } from 'vitest'
import { INSPECTOR_PROTOCOL_VERSION, parseSourceFrame, parseWorkerSourceFrame } from '../src/shared/bridge/messages/observation.ts'
import type { WorkerToSourceFrame } from '../src/shared/bridge/messages/observation.ts'
import { inspectorId } from '../src/shared/identity.ts'
import { ClientRuntimeRouter, type ClientRuntimeTarget } from '../src/worker/bridge/runtime-rpc.ts'
import { InspectorSourceRegistry, type InspectorRecordConsumer, type SourceConnection } from '../src/worker/bridge/hub.ts'

describe('Inspector source protocol', () => {
  it('rebuilds a valid source frame and rejects non-JSON payloads', () => {
    const frame = parseSourceFrame({
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/append',
      sourceId: 'host-1',
      generation: 'generation-1',
      firstSequence: 1,
      droppedBefore: 0,
      records: [{ monotonicMs: 12, topic: 'probe', payload: { ok: true } }],
    }, 4)
    expect(frame.t).toBe('source/append')
    expect(() => parseSourceFrame({
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/append',
      sourceId: 'host-1',
      generation: 'generation-1',
      firstSequence: 1,
      droppedBefore: 0,
      records: [{ monotonicMs: 12, topic: 'probe', payload: { bad: undefined } }],
    }, 4)).toThrow('lossless JSON object')
  })

  it('isolates generations and reports sequence gaps', () => {
    const replace = vi.fn()
    const append = vi.fn()
    const close = vi.fn()
    const consumer: InspectorRecordConsumer = {
      topics: new Set(['probe']),
      replace,
      append,
      close,
    }
    const replies: unknown[] = []
    const send = vi.fn((frame: unknown) => { replies.push(frame) })
    const closeConnection = vi.fn()
    const connection: SourceConnection = {
      kind: 'host',
      send,
      close: closeConnection,
    }
    const registry = new InspectorSourceRegistry([consumer], 16_384, 4)
    registry.receive(connection, {
      v: 0,
      t: 'source/open',
      source: {
        sourceId: 'host-1',
        generation: 'g-1',
        kind: 'host',
        label: 'Host',
        timeOriginMs: 1_000,
        capabilities: [],
      },
      topics: ['probe'],
    })
    registry.receive(connection, {
      v: 0,
      t: 'source/append',
      sourceId: 'host-1',
      generation: 'g-1',
      firstSequence: 2,
      droppedBefore: 1,
      records: [{ monotonicMs: 1, topic: 'probe', payload: { value: 1 } }],
    })

    expect(append).toHaveBeenCalledOnce()
    expect(registry.describe()[0]).toMatchObject({ expectedSequence: 3, dropped: 1, topics: { probe: 1 } })

    registry.receive(connection, {
      v: 0,
      t: 'source/append',
      sourceId: 'host-1',
      generation: 'g-1',
      firstSequence: 5,
      droppedBefore: 0,
      records: [],
    })
    expect(replies.at(-1)).toMatchObject({ t: 'source/resnapshot', expectedSequence: 3 })
    expect(append).toHaveBeenCalledOnce()
  })

  it('cancels the Client Runtime request its deadline ended and keeps serving that session', async () => {
    const frames: WorkerToSourceFrame[] = []
    const connection: SourceConnection = {
      kind: 'client',
      send: (frame) => { frames.push(frame) },
      close: () => {},
    }
    const registry = new InspectorSourceRegistry([], 16_384, 4)
    const router = new ClientRuntimeRouter(registry, 20)
    let target: ClientRuntimeTarget | undefined
    router.subscribe((event) => { if (event.type === 'opened') target = event.target })
    registry.receive(connection, {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'source/open',
      source: {
        sourceId: 'client-1',
        generation: 'g-1',
        kind: 'client',
        label: 'Deadline Client',
        timeOriginMs: 0,
        capabilities: [{ type: 'client-runtime', origin: 'https://client.invalid' }],
      },
      topics: [],
    })
    if (target === undefined) throw new Error('the Client Runtime target was never admitted')
    const sessionId = inspectorId<'ClientRuntimeSessionId'>('devtools-1', 'sessionId')

    // This Client answers nothing, so the deadline is the only settlement its
    // first request can reach, whatever the host is doing meanwhile.
    await expect(router.request(target, sessionId, {
      op: 'evaluate',
      expression: 'new Promise(() => {})',
      awaitPromise: true,
    })).rejects.toThrow('Client Runtime evaluate timed out after 20ms')
    const abandoned = sentRequestIds(frames).at(-1)
    expect(abandoned).toBeTypeOf('string')
    expect(addressedFrames(frames, 'client-runtime/cancel', abandoned!)).toBe(1)

    const served = router.request(target, sessionId, { op: 'evaluate', expression: '6 * 7', returnByValue: true })
    const requestId = sentRequestIds(frames).at(-1)
    expect(requestId).not.toBe(abandoned)
    registry.receive(connection, {
      v: INSPECTOR_PROTOCOL_VERSION,
      t: 'client-runtime/response',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId,
      requestId,
      outcome: {
        ok: true,
        result: { op: 'evaluate', completion: { result: { descriptor: { type: 'number', value: 42 } } } },
      },
    })
    await expect(served).resolves.toMatchObject({
      op: 'evaluate',
      completion: { result: { descriptor: { type: 'number', value: 42 } } },
    })
    expect(addressedFrames(frames, 'client-runtime/response-acknowledged', requestId!)).toBe(1)
    expect(addressedFrames(frames, 'client-runtime/cancel', requestId!)).toBe(0)

    router.close()
    registry.close()
  })

  it('closes only a malformed source connection', () => {
    const send = vi.fn()
    const closeConnection = vi.fn()
    const connection: SourceConnection = {
      kind: 'client',
      send,
      close: closeConnection,
    }
    const registry = new InspectorSourceRegistry([], 1_024, 2)
    registry.receive(connection, { v: 99, t: 'source/open' })
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ t: 'source/rejected' }))
    expect(closeConnection).toHaveBeenCalledOnce()
  })

  it('decodes Runtime commands and rejects undeclared fields', () => {
    const request = parseWorkerSourceFrame({
      v: 0,
      t: 'client-runtime/request',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
      requestId: 'request-1',
      command: {
        op: 'call-function',
        functionDeclaration: 'function () { return this.value }',
        receiver: 'object-1',
        arguments: [{ kind: 'unserializable', value: 'NaN' }],
        returnByValue: true,
      },
    })
    expect(request).toMatchObject({
      t: 'client-runtime/request',
      command: { op: 'call-function', receiver: 'object-1', returnByValue: true },
    })
    if (request.t !== 'client-runtime/request') throw new Error('unexpected frame type')
    expect(() => parseWorkerSourceFrame({
      ...request,
      command: { ...request.command, unversionedExtension: true },
    })).toThrow('unknown field')

    expect(parseWorkerSourceFrame({
      v: 0,
      t: 'client-runtime/response-acknowledged',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
      requestId: 'request-1',
    })).toMatchObject({ t: 'client-runtime/response-acknowledged', requestId: 'request-1' })
  })

  it('rejects invalid RemoteObject representations', () => {
    expect(() => parseSourceFrame({
      v: 0,
      t: 'client-runtime/response',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
      requestId: 'request-1',
      outcome: {
        ok: true,
        result: {
          op: 'evaluate',
          completion: {
            result: {
              descriptor: { type: 'number', value: 1 },
              object: { handle: 'object-1' },
            },
          },
        },
      },
    }, 4)).toThrow('invalid number RemoteObject representation')
  })

  it('decodes exact Client Console lifecycle and event frames', () => {
    expect(parseWorkerSourceFrame({
      v: 0,
      t: 'client-console/enable',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
    })).toMatchObject({ t: 'client-console/enable', sessionId: 'session-1' })

    const frame = parseSourceFrame({
      v: 0,
      t: 'client-console/event',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
      event: {
        type: 'console-api',
        event: {
          type: 'log',
          arguments: [{
            descriptor: { type: 'object', className: 'Object', description: 'Object' },
            object: { handle: 'object-1' },
          }],
          timestamp: 12,
        },
      },
    }, 4)
    expect(frame).toMatchObject({
      t: 'client-console/event',
      sessionId: 'session-1',
      event: {
        type: 'console-api',
        event: { type: 'log', arguments: [{ object: { handle: 'object-1' } }] },
      },
    })

    expect(() => parseWorkerSourceFrame({
      v: 0,
      t: 'client-console/disable',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
      extra: true,
    })).toThrow('unknown field')
  })

  it('decodes the Client confirmation that Console observation is installed', () => {
    expect(parseSourceFrame({
      v: 0,
      t: 'client-console/enabled',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
    }, 4)).toMatchObject({ t: 'client-console/enabled', sessionId: 'session-1' })

    expect(() => parseSourceFrame({
      v: 0,
      t: 'client-console/enabled',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
      extra: true,
    }, 4)).toThrow('unknown field')
    expect(() => parseSourceFrame({
      v: 0,
      t: 'client-console/enabled',
      sourceId: 'client-1',
      generation: 'g-1',
    }, 4)).toThrow('sessionId')
    // A Worker never receives its own enable request back on the source carrier.
    expect(() => parseSourceFrame({
      v: 0,
      t: 'client-console/enable',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'session-1',
    }, 4)).toThrow('unknown source frame')
  })

  it('decodes bounded Client source commands and responses', () => {
    expect(parseWorkerSourceFrame({
      v: 0,
      t: 'client-sources/request',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'source-session-1',
      requestId: 'source-request-1',
      command: {
        op: 'get-content-chunk',
        scriptKey: 'bundle',
        content: 'source',
        offset: 0,
        maxBytes: 1024,
      },
    })).toMatchObject({
      t: 'client-sources/request',
      command: { op: 'get-content-chunk', maxBytes: 1024 },
    })

    expect(parseSourceFrame({
      v: 0,
      t: 'client-sources/response',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'source-session-1',
      requestId: 'source-request-1',
      outcome: {
        ok: true,
        result: {
          op: 'get-content-chunk',
          scriptKey: 'bundle',
          content: 'source',
          available: true,
          offset: 0,
          nextOffset: 3,
          data: 'YWJj',
          eof: true,
        },
      },
    }, 4)).toMatchObject({
      t: 'client-sources/response',
      outcome: { ok: true, result: { data: 'YWJj', eof: true } },
    })

    expect(() => parseSourceFrame({
      v: 0,
      t: 'client-sources/response',
      sourceId: 'client-1',
      generation: 'g-1',
      sessionId: 'source-session-1',
      requestId: 'source-request-1',
      outcome: {
        ok: true,
        result: {
          op: 'get-content-chunk',
          scriptKey: 'bundle',
          content: 'source',
          available: true,
          offset: 0,
          nextOffset: 3,
          data: 'not base64',
          eof: true,
        },
      },
    }, 4)).toThrow('chunk data')
  })
})

function sentRequestIds(frames: readonly WorkerToSourceFrame[]): string[] {
  const ids: string[] = []
  for (const frame of frames) if (frame.t === 'client-runtime/request') ids.push(frame.requestId)
  return ids
}

function addressedFrames(
  frames: readonly WorkerToSourceFrame[],
  tag: WorkerToSourceFrame['t'],
  requestId: string,
): number {
  return frames.filter(frame => frame.t === tag && 'requestId' in frame && frame.requestId === requestId).length
}
