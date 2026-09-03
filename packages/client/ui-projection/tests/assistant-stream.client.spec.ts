/**
 * The shared Assistant block accumulation: what each streamed chunk, chunk run,
 * and settlement does to the blocks, the visible count, and the timing
 * boundaries every Conversation target reads off the same walk.
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm/types'
import type { ChunkRowEvent } from '@deepseek-ai/dsh-api-session-controller/types'
import {
  EMPTY_ASSISTANT_STREAM, SYNTHETIC_SEQ_OFFSETS, applyAssistantChunk, applyChunkRun,
  assistantFinalNode, assistantStepPublication, blockIsVisible, closedLocationBoundary,
  compactBlocks, isChunkRunEvent, settledBlocks,
  type AssistantStream,
} from '../src/assistant-stream.ts'
import type {
  ConversationLocation, ConversationMatch,
} from '@deepseek-ai/dsh-client-ui-conversation/client'

const chunk = (value: unknown): StreamChunk => value as StreamChunk
const run = (value: unknown): ChunkRowEvent => value as ChunkRowEvent
const match = (event: unknown): ConversationMatch => ({
  event, role: 'update', location: { kind: 'unresolved' },
} as unknown as ConversationMatch)

function apply(stream: AssistantStream, value: unknown, seq = 10, time = 100): AssistantStream {
  const next = applyAssistantChunk(stream, chunk(value), seq, time)
  if (next === null) throw new Error('chunk changed no block')
  return next
}

describe('applyAssistantChunk', () => {
  it('opens a block, appends text and reasoning deltas, and accumulates a tool call', () => {
    let stream = apply(EMPTY_ASSISTANT_STREAM, { type: 'block-start', index: 0, blockType: 'text' })
    expect(stream.blocks).toEqual([{ kind: 'text', text: '' }])
    expect(stream.visibleBlocks).toBe(0)

    stream = apply(stream, { type: 'text-delta', index: 0, text: 'hi' }, 11, 101)
    expect(stream.blocks[0]).toEqual({ kind: 'text', text: 'hi' })
    expect(stream.visibleBlocks).toBe(1)
    expect(stream.firstVisibleSeq).toBe(11)
    expect(stream.firstVisibleTime).toBe(101)
    expect(stream.firstTokenTime).toBe(101)

    stream = apply(stream, { type: 'reasoning-delta', index: 1, text: 'why' }, 12, 102)
    expect(stream.blocks[1]).toEqual({ kind: 'reasoning', text: 'why' })

    stream = apply(stream, { type: 'tool-call-delta', index: 2, id: 'c1', name: 'read', argumentsDelta: '{"a' }, 13, 103)
    stream = apply(stream, { type: 'tool-call-delta', index: 2, id: 'c1', argumentsDelta: '":1}' }, 14, 104)
    expect(stream.blocks[2]).toEqual({ kind: 'tool-call', callId: 'c1', name: 'read', argsRaw: '{"a":1}' })
    // A tool call never counts as visible content.
    expect(stream.visibleBlocks).toBe(2)
    // The first visible and first token boundaries are recorded once.
    expect(stream.firstVisibleSeq).toBe(11)
    expect(stream.firstTokenTime).toBe(101)
  })

  it('replaces a streamed block with the finalized block-end value', () => {
    let stream = apply(EMPTY_ASSISTANT_STREAM, { type: 'block-start', index: 0, blockType: 'text' })
    stream = apply(stream, { type: 'text-delta', index: 0, text: 'partial' }, 11, 101)
    stream = apply(stream, {
      type: 'block-end', index: 0, block: { type: 'text', text: 'final' },
    }, 12, 102)
    expect(stream.blocks[0]).toEqual({ kind: 'text', text: 'final' })
    expect(stream.visibleBlocks).toBe(1)
  })

  it('reports a chunk that changes no block so each target decides what it means', () => {
    expect(applyAssistantChunk(EMPTY_ASSISTANT_STREAM, chunk({ type: 'usage', usage: {} }), 1, 1))
      .toBeNull()
    expect(applyAssistantChunk(EMPTY_ASSISTANT_STREAM, chunk({ type: 'finish', reason: 'stop' }), 1, 1))
      .toBeNull()
  })

  it('starts a tool call from a delta that opened no block', () => {
    const stream = apply(EMPTY_ASSISTANT_STREAM, {
      type: 'tool-call-delta', index: 0, id: 7, argumentsDelta: '{}',
    })
    expect(stream.blocks[0]).toEqual({ kind: 'tool-call', callId: '7', name: '', argsRaw: '{}' })
  })
})

describe('applyChunkRun', () => {
  it('appends a text run onto the block already at its index', () => {
    const opened = apply(EMPTY_ASSISTANT_STREAM, { type: 'text-delta', index: 0, text: 'a' }, 5, 50)
    const stream = applyChunkRun(opened, run({
      type: 'chunkrow/text-chunks', seq: 6, time: 60,
      data: { index: 0, texts: ['b', 'c'], dt: [1, 1] },
    }))
    expect(stream.blocks[0]).toEqual({ kind: 'text', text: 'abc' })
    expect(stream.visibleBlocks).toBe(1)
  })

  it('appends a reasoning run and dates the first visible fragment inside the run', () => {
    const stream = applyChunkRun(EMPTY_ASSISTANT_STREAM, run({
      type: 'chunkrow/reasoning-chunks', seq: 20, time: 200,
      data: { index: 0, texts: ['', ' ', 'why'], dt: [5, 5, 5] },
    }))
    expect(stream.blocks[0]).toEqual({ kind: 'reasoning', text: ' why' })
    // Fragment 0 is empty and fragment 1 is blank, so the run's third fragment
    // is the first visible one: seq + 2, and its reconstructed time.
    expect(stream.firstVisibleSeq).toBe(22)
    expect(stream.firstVisibleTime).toBe(210)
    // The first non-empty fragment is the token boundary, one fragment earlier.
    expect(stream.firstTokenTime).toBe(205)
  })

  it('continues a reasoning run already carrying visible text', () => {
    const opened = apply(EMPTY_ASSISTANT_STREAM, { type: 'reasoning-delta', index: 0, text: 'a' }, 5, 50)
    const stream = applyChunkRun(opened, run({
      type: 'chunkrow/reasoning-chunks', seq: 6, time: 60,
      data: { index: 0, texts: ['b'], dt: [1] },
    }))
    expect(stream.blocks[0]).toEqual({ kind: 'reasoning', text: 'ab' })
  })

  it('appends a tool-call run, keeping the first name and call id it saw', () => {
    const opened = apply(EMPTY_ASSISTANT_STREAM, {
      type: 'tool-call-delta', index: 0, id: 'c1', name: 'read', argumentsDelta: '{',
    }, 5, 50)
    const stream = applyChunkRun(opened, run({
      type: 'chunkrow/tool-call-chunks', seq: 6, time: 60,
      data: { index: 0, id: 'c9', args: ['"a"', ':1}'], dt: [1, 1] },
    }))
    expect(stream.blocks[0]).toEqual({
      kind: 'tool-call', callId: 'c1', name: 'read', argsRaw: '{"a":1}',
    })
  })

  it('names a tool call the run itself introduces', () => {
    const stream = applyChunkRun(EMPTY_ASSISTANT_STREAM, run({
      type: 'chunkrow/tool-call-chunks', seq: 6, time: 60,
      data: { index: 0, id: 'c9', name: 'write', args: ['{}'], dt: [1] },
    }))
    expect(stream.blocks[0]).toEqual({
      kind: 'tool-call', callId: 'c9', name: 'write', argsRaw: '{}',
    })
    // A tool-call run never becomes visible content, so no visible boundary lands.
    expect(stream.firstVisibleSeq).toBeUndefined()
    // Its name alone starts the token clock at the run's own time.
    expect(stream.firstTokenTime).toBe(60)
  })

  it('dates a run against a stream that is already visible elsewhere', () => {
    const visible = apply(EMPTY_ASSISTANT_STREAM, { type: 'text-delta', index: 0, text: 'seen' }, 5, 50)
    const stream = applyChunkRun({ ...visible, firstVisibleSeq: undefined, firstVisibleTime: undefined }, run({
      type: 'chunkrow/text-chunks', seq: 9, time: 90,
      data: { index: 1, texts: ['x'], dt: [] },
    }))
    expect(stream.firstVisibleSeq).toBe(9)
    expect(stream.firstVisibleTime).toBe(90)
  })
})

describe('block predicates', () => {
  it('counts only rendered content as visible', () => {
    expect(blockIsVisible(undefined)).toBe(false)
    expect(blockIsVisible({ kind: 'tool-call', callId: 'c', name: 'n', argsRaw: '' })).toBe(false)
    expect(blockIsVisible({ kind: 'text', text: '  ' })).toBe(false)
    expect(blockIsVisible({ kind: 'reasoning', text: 'why' })).toBe(true)
    expect(blockIsVisible({ kind: 'other', block: null })).toBe(true)
  })

  it('drops the index gaps a partial stream leaves behind', () => {
    expect(compactBlocks([undefined, { kind: 'text', text: 'a' }, undefined]))
      .toEqual([{ kind: 'text', text: 'a' }])
  })

  it('recognizes the three coalesced chunk-run rows and nothing else', () => {
    for (const type of [
      'chunkrow/text-chunks', 'chunkrow/reasoning-chunks', 'chunkrow/tool-call-chunks',
    ]) {
      expect(isChunkRunEvent({ type } as ConversationMatch['event'])).toBe(true)
    }
    expect(isChunkRunEvent({ type: 'assistant/chunk' } as ConversationMatch['event'])).toBe(false)
  })

  it('replaces the accumulated blocks with a settled message content', () => {
    expect(settledBlocks([
      { type: 'text', text: 'a' }, { type: 'text', text: ' ' },
    ] as never)).toEqual({
      blocks: [{ kind: 'text', text: 'a' }, { kind: 'text', text: ' ' }],
      visibleBlocks: 1,
    })
  })
})

const openStep: ConversationLocation = {
  kind: 'step',
  turn: { status: 'open', end: undefined },
  step: { status: 'open', end: undefined },
} as unknown as ConversationLocation

const closedStep: ConversationLocation = {
  kind: 'step',
  turn: { status: 'open', end: undefined },
  step: { status: 'closed', end: { seq: 42, time: 420 } },
} as unknown as ConversationLocation

const closedTurn: ConversationLocation = {
  kind: 'turn',
  turn: { status: 'closed', end: { seq: 7, time: 70 } },
} as unknown as ConversationLocation

describe('closedLocationBoundary', () => {
  it('reads the closing boundary of a closed step, then of a closed turn', () => {
    expect(closedLocationBoundary(closedStep)).toEqual({ seq: 42, time: 420 })
    expect(closedLocationBoundary(closedTurn)).toEqual({ seq: 7, time: 70 })
  })

  it('reports no boundary while the step and turn are open, or with no location', () => {
    expect(closedLocationBoundary(openStep)).toBeUndefined()
    expect(closedLocationBoundary(undefined)).toBeUndefined()
    expect(closedLocationBoundary({ kind: 'session' })).toBeUndefined()
  })
})

const settledMatch = match({
  type: 'assistant/message',
  seq: 30,
  time: 300,
  data: {
    message: {
      id: 'm1',
      content: [{ type: 'text', text: 'done' }],
      source: { provider: 'deepseek', model: 'chat' },
    },
    usage: { inputTokens: 1, outputTokens: 2 },
  },
})

describe('assistantFinalNode', () => {
  const base = {
    turn: 1,
    step: 2,
    stream: { ...EMPTY_ASSISTANT_STREAM, firstTokenTime: 250 },
  }

  it('projects a settled message without provider identity', () => {
    expect(assistantFinalNode(
      { ...base, final: settledMatch },
      { stepStartTime: 200, withProvenance: false },
      undefined,
    )).toEqual({
      kind: 'assistant',
      seq: 30,
      messageId: 'm1',
      time: 300,
      turn: 1,
      step: 2,
      blocks: [{ kind: 'text', text: 'done' }],
      usage: { inputTokens: 1, outputTokens: 2 },
      timing: { stepStartTime: 200, firstTokenTime: 250, completedTime: 300 },
    })
  })

  it('adds the answering provider and model when the target presents them', () => {
    const node = assistantFinalNode(
      { ...base, final: settledMatch },
      { stepStartTime: null, withProvenance: true },
      undefined,
    )
    expect(node?.provenance).toEqual({ provider: 'deepseek', model: 'chat' })
    expect(node?.timing).toEqual({ stepStartTime: null, firstTokenTime: 250, completedTime: 300 })
  })

  it('carries a durably interrupted settlement through', () => {
    const interrupted = match({
      ...(settledMatch.event as { data: unknown }),
      type: 'assistant/message',
      seq: 30,
      time: 300,
      data: {
        message: { id: 'm1', content: [], source: { provider: 'p', model: 'm' } },
        usage: undefined,
        interrupted: true,
      },
    })
    expect(assistantFinalNode(
      { ...base, final: interrupted },
      { stepStartTime: null, withProvenance: false },
      undefined,
    )?.interrupted).toBe(true)
  })

  it('freezes a chunk-only prefix at the closing boundary', () => {
    const node = assistantFinalNode(
      {
        ...base,
        final: undefined,
        stream: { ...EMPTY_ASSISTANT_STREAM, blocks: [{ kind: 'text', text: 'partial' }] },
      },
      { stepStartTime: null, withProvenance: false },
      { seq: 42, time: 420 },
    )
    expect(node).toEqual({
      kind: 'assistant',
      seq: 42 + SYNTHETIC_SEQ_OFFSETS.interruptedAssistant,
      time: 420,
      turn: 1,
      step: 2,
      blocks: [{ kind: 'text', text: 'partial' }],
      interrupted: true,
    })
  })

  it('freezes a Tool call as interruption evidence even though it renders no content', () => {
    const node = assistantFinalNode(
      {
        ...base,
        final: undefined,
        stream: {
          ...EMPTY_ASSISTANT_STREAM,
          blocks: [{ kind: 'tool-call', callId: 'c', name: 'n', argsRaw: '' }],
        },
      },
      { stepStartTime: null, withProvenance: false },
      { seq: 42, time: 420 },
    )
    expect(node?.interrupted).toBe(true)
  })

  it('projects nothing while the step is open, or when its prefix is blank', () => {
    expect(assistantFinalNode(
      { ...base, final: undefined },
      { stepStartTime: null, withProvenance: false },
      undefined,
    )).toBeUndefined()
    expect(assistantFinalNode(
      {
        ...base,
        final: undefined,
        stream: { ...EMPTY_ASSISTANT_STREAM, blocks: [{ kind: 'text', text: '   ' }] },
      },
      { stepStartTime: null, withProvenance: false },
      { seq: 42, time: 420 },
    )).toBeUndefined()
  })
})

describe('assistantStepPublication', () => {
  it('coalesces streamed content, publishes bookkeeping chunks nowhere, and settles immediately', () => {
    expect(assistantStepPublication(match({ type: 'step/start' }))).toBe('none')
    expect(assistantStepPublication(match({ type: 'chunkrow/text-chunks' }))).toBe('animation-frame')
    expect(assistantStepPublication(match({ type: 'assistant/message' }))).toBe('immediate')
    expect(assistantStepPublication(match({
      type: 'assistant/chunk', data: { chunk: { type: 'text-delta' } },
    }))).toBe('animation-frame')
    expect(assistantStepPublication(match({
      type: 'assistant/chunk', data: { chunk: { type: 'usage' } },
    }))).toBe('none')
    expect(assistantStepPublication(match({
      type: 'assistant/chunk', data: { chunk: { type: 'finish' } },
    }))).toBe('none')
  })
})
