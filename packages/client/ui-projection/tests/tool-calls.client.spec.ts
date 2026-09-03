/**
 * The shared Tool-call record projection: which events open one root Tool
 * lifecycle, the records each event builds, and the rule that decides whether a
 * Code Dispatch edge may join the call graph.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_TOOL_CALL_DEPTH, acceptsSubcallEdge, childToolCall, childToolResult,
  interruptedToolResult, locationStep, locationTurn, rootToolCall, rootToolResult, toolCallMatch,
  type DispatchData, type SubcallGraph,
} from '../src/tool-calls.ts'
import type {
  ConversationMatch, RunningToolCall,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

const match = (event: unknown, location: unknown = { kind: 'unresolved' }): ConversationMatch => ({
  event, role: 'update', location,
} as unknown as ConversationMatch)

const callEvent = {
  type: 'tool/call',
  seq: 5,
  time: 50,
  data: { callId: 'c1', name: 'read', arguments: '{"path":"a"}', turn: 1, step: 2 },
}

const resultEvent = {
  type: 'tool/result',
  seq: 9,
  time: 90,
  data: {
    message: { source: { callId: 'c1' }, content: [{ content: [{ type: 'text' }], isError: false }] },
    meta: { bytes: 3 },
  },
}

const dispatch: DispatchData = {
  parentCallId: 'c1',
  subCallId: 's1',
  name: 'grep',
  arguments: { pattern: 'x' },
}

describe('toolCallMatch', () => {
  it('opens on tool/call, updates on an accepted result, and keys dispatches by root', () => {
    expect(toolCallMatch(callEvent as never, () => true))
      .toEqual({ id: 'c1', role: 'start' })
    expect(toolCallMatch(resultEvent as never, () => true))
      .toEqual({ id: 'c1', role: 'update' })
    expect(toolCallMatch({
      type: 'tool/code-dispatch-start', data: { rootCallId: 'c1' },
    } as never, () => true)).toEqual({ id: 'c1', role: 'update' })
    expect(toolCallMatch({
      type: 'tool/code-dispatch', data: { rootCallId: 'c1' },
    } as never, () => true)).toEqual({ id: 'c1', role: 'update' })
  })

  it('declines a result the target rejects, an unrooted dispatch, and unrelated events', () => {
    expect(toolCallMatch(resultEvent as never, () => false)).toBeNull()
    expect(toolCallMatch({
      type: 'tool/code-dispatch', data: { rootCallId: '' },
    } as never, () => true)).toBeNull()
    expect(toolCallMatch({
      type: 'tool/code-dispatch', data: {},
    } as never, () => true)).toBeNull()
    expect(toolCallMatch({ type: 'turn/start', data: {} } as never, () => true)).toBeNull()
  })
})

describe('root records', () => {
  it('builds the running root call of a tool/call', () => {
    expect(rootToolCall(match(callEvent), 'tool-call')).toEqual({
      callId: 'c1', name: 'read', argsRaw: '{"path":"a"}', turn: 1, step: 2, time: 50, subCalls: [],
    })
  })

  it('names the Definition kind when a Context starts on the wrong event', () => {
    expect(() => rootToolCall(match({ type: 'turn/start' }), 'trajectory-tool-call'))
      .toThrow('trajectory-tool-call start requires tool/call')
  })

  it('backfills the call head from an in-window running call', () => {
    const running: RunningToolCall = {
      callId: 'c1', name: 'read', argsRaw: '{"path":"a"}', turn: 1, step: 2, time: 50, subCalls: [],
    }
    expect(rootToolResult(match(resultEvent), running)).toMatchObject({
      kind: 'tool-result',
      seq: 9,
      time: 90,
      callId: 'c1',
      call: { name: 'read', argsRaw: '{"path":"a"}' },
      callTime: 50,
      isError: false,
      meta: { bytes: 3 },
    })
  })

  it('leaves the call head null when window truncation dropped the call', () => {
    const settled = rootToolResult(match(resultEvent))
    expect(settled?.call).toBeNull()
    expect(settled?.callTime).toBeNull()
    expect(settled).not.toHaveProperty('error')
  })

  it('carries a logged error and reports a non-result match as no result', () => {
    const failed = rootToolResult(match({
      ...resultEvent,
      data: { ...resultEvent.data, error: { name: 'Failed', code: 'E' } },
    }))
    expect(failed?.error).toEqual({ name: 'Failed', code: 'E' })
    expect(rootToolResult(match({ type: 'tool/call' }))).toBeUndefined()
  })
})

describe('child records', () => {
  it('reads the turn and step of a dispatch from its resolved location', () => {
    const stepMatch = match({ type: 'tool/code-dispatch-start', time: 60 }, {
      kind: 'step', turn: { turn: 3 }, step: { step: 4 },
    })
    expect(childToolCall(stepMatch, dispatch)).toEqual({
      callId: 's1',
      parentCallId: 'c1',
      name: 'grep',
      argsRaw: '{"pattern":"x"}',
      turn: 3,
      step: 4,
      time: 60,
      subCalls: [],
    })
  })

  it('falls back to turn 0 step 0 when the location resolved neither', () => {
    const turnOnly = match({ type: 'tool/code-dispatch-start', time: 60 }, {
      kind: 'turn', turn: { turn: 8 },
    })
    expect(locationTurn(turnOnly)).toBe(8)
    expect(locationStep(turnOnly)).toBe(0)
    const unresolved = match({ type: 'tool/code-dispatch-start', time: 60 })
    expect(locationTurn(unresolved)).toBe(0)
    expect(locationStep(unresolved)).toBe(0)
  })

  it('settles a child with the call time the target supplies and an empty default content', () => {
    expect(childToolResult(match({ type: 'tool/code-dispatch', seq: 11, time: 110 }), dispatch, 60))
      .toEqual({
        kind: 'tool-result',
        seq: 11,
        time: 110,
        callId: 's1',
        parentCallId: 'c1',
        call: { name: 'grep', argsRaw: '{"pattern":"x"}' },
        callTime: 60,
        content: [],
        isError: false,
        subCalls: [],
      })
  })

  it('keeps logged child content and its error flag', () => {
    const settled = childToolResult(
      match({ type: 'tool/code-dispatch', seq: 11, time: 110 }),
      { ...dispatch, isError: true, content: [{ type: 'text', text: 'no' }] as never },
      null,
    )
    expect(settled.isError).toBe(true)
    expect(settled.content).toEqual([{ type: 'text', text: 'no' }])
    expect(settled.callTime).toBeNull()
  })
})

function graph(
  parents: Record<string, string>,
  children: Record<string, readonly string[]> = {},
): SubcallGraph {
  return {
    parents: new Map(Object.entries(parents)),
    childIds: callId => children[callId] ?? [],
  }
}

describe('acceptsSubcallEdge', () => {
  it('accepts a fresh edge under an existing parent', () => {
    expect(acceptsSubcallEdge(graph({}), 'c1', 's1')).toBe(true)
  })

  it('rejects self-parenting and re-parenting an adopted call', () => {
    expect(acceptsSubcallEdge(graph({}), 'c1', 'c1')).toBe(false)
    expect(acceptsSubcallEdge(graph({ s1: 'other' }), 'c1', 's1')).toBe(false)
  })

  it('rejects an edge whose parent chain already reaches the child', () => {
    expect(acceptsSubcallEdge(graph({ c1: 'a', a: 's1' }), 'c1', 's1')).toBe(false)
  })

  it('rejects an edge whose ancestor chain already cycles', () => {
    expect(acceptsSubcallEdge(graph({ c1: 'a', a: 'c1' }), 'c1', 's1')).toBe(false)
  })

  it('rejects a subtree that reaches the same call twice', () => {
    expect(acceptsSubcallEdge(graph({}, { s1: ['x'], x: ['s1'] }), 'c1', 's1')).toBe(false)
  })

  it('rejects an edge whose combined ancestor and subtree depth exceeds the bound', () => {
    const parents: Record<string, string> = {}
    for (let i = 1; i < MAX_TOOL_CALL_DEPTH; i++) parents[`n${String(i)}`] = `n${String(i + 1)}`
    expect(acceptsSubcallEdge(graph(parents), 'n1', 'fresh')).toBe(false)
  })
})

describe('interruptedToolResult', () => {
  const running: RunningToolCall = {
    callId: 's1', name: 'grep', argsRaw: '{}', turn: 1, step: 2, time: 60, subCalls: [],
  }

  it('freezes a running root call at the closing boundary', () => {
    expect(interruptedToolResult(running, { seq: 42, time: 420 }, 41.2, [])).toEqual({
      kind: 'tool-result',
      seq: 41.2,
      time: 420,
      callId: 's1',
      call: { name: 'grep', argsRaw: '{}' },
      callTime: 60,
      content: [],
      isError: true,
      error: { name: 'Interrupted', code: 'interrupted' },
      subCalls: [],
    })
  })

  it('keeps a frozen child under its parent and carries its projected subcalls', () => {
    const child = interruptedToolResult(
      { ...running, parentCallId: 'c1' },
      { seq: 42, time: 420 },
      41.2,
      [running],
    )
    expect(child.parentCallId).toBe('c1')
    expect(child.subCalls).toEqual([running])
  })
})
