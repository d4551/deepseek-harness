import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { eventLines } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { scrubSessionSnapshot } from '@deepseek-ai/dsh-session-snapshot'
import {
  canonicalSessionFixture,
  inspectSessionFixtureLayouts,
  isPhysicalSessionFixture,
} from './session-fixture-layout.ts'

const HEADER = '  {"type":"session","version":0,"id":"fixture","createdAt":1,"delegationDepth":0}  '
const root = resolve(import.meta.dirname, '..')

function chunkRun(): SessionEvent[] {
  return Array.from({ length: 4 }, (_, index) => ({
    type: 'assistant/chunk',
    seq: index,
    time: 10 + index,
    data: {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: `part-${index}` },
    },
  }))
}

function unpackedFixture(): string {
  return [HEADER, ...chunkRun().map(event => JSON.stringify(event)), ''].join('\n')
}

function decodedBody(content: string): SessionEvent[] {
  return parseSessionLog(content)
}

describe('canonicalSessionFixture', () => {
  it('preserves the header line and packs an unpacked event run losslessly', () => {
    const canonical = canonicalSessionFixture(unpackedFixture(), 'fixture.jsonl')
    expect(canonical).toBeDefined()
    expect(canonical?.split('\n')[0]).toBe(HEADER)
    const packed = JSON.parse(canonical?.split('\n')[1] ?? '{}') as Record<string, unknown>
    expect(packed).toMatchObject({ type: 'text-chunks' })
    expect(packed).not.toHaveProperty('seq0')
    expect(packed).not.toHaveProperty('time0')
    expect(decodedBody(canonical ?? '').map(({ seq: _seq, time: _time, ...event }) => event))
      .toStrictEqual(chunkRun().map(({ seq: _seq, time: _time, ...event }) => event))
  })

  it('ignores JSONL whose first record is not a session header', () => {
    expect(canonicalSessionFixture('{"type":"session_event"}\n{"value":1}\n')).toBeUndefined()
  })

  it('is idempotent for an already packed fixture', () => {
    const packed = canonicalSessionFixture(unpackedFixture())
    expect(packed).toBeDefined()
    expect(canonicalSessionFixture(packed ?? '')).toBe(packed)
  })

  it('is idempotent for an already projected fixture', () => {
    const projected = [
      HEADER,
      '{"type":"turn/start","data":{"turn":1,"seq":99,"time":100}}',
      '',
    ].join('\n')
    expect(canonicalSessionFixture(projected)).toBe(projected)
  })

  it('fails loud on malformed records after a session header', () => {
    expect(() => canonicalSessionFixture(`${HEADER}\n{not-json}\n`, 'broken.jsonl'))
      .toThrow(/broken\.jsonl: session snapshot line 2 contains invalid JSON/)
  })

  it('labels malformed packed rows with the fixture path and line', () => {
    expect(() => canonicalSessionFixture(`${HEADER}\n{"type":"text-chunks"}\n`, 'broken.jsonl'))
      .toThrow(/broken\.jsonl: session snapshot line 2: malformed text-chunks storage row/)
  })
})

/** One `assistant/chunk` text delta as the persistence encoder receives it. */
function textDelta(seq: number, text: string): SessionEvent {
  return {
    type: 'assistant/chunk',
    seq,
    time: 1_000 + seq,
    data: { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text } },
  }
}

/** The provenance-carrying record class: an `assistant/message` citing the chunk seqs that built it. */
function assistantMessage(seq: number, sourceEventSeqs: readonly number[]): SessionEvent<'assistant/message'> {
  return {
    type: 'assistant/message',
    seq,
    time: 1_000 + seq,
    surfaceOp: 'append',
    sourceEventSeqs: [...sourceEventSeqs],
    data: {
      turn: 1,
      step: 1,
      message: {
        id: MessageId('message-0'),
        role: 'assistant',
        content: [{ type: 'text', text: 'abcdef' }],
        source: { kind: 'model', provider: 'fixture', model: 'fixture-model' },
      },
    },
  }
}

/** A log in the physical layout the JSONL backend writes: one `eventLines` batch per durable flush. */
function persistedLog(batches: readonly (readonly SessionEvent[])[]): string {
  return [HEADER.trim(), ...batches.map(batch => eventLines(batch, true)), ''].join('\n')
}

const RUN = Array.from({ length: 6 }, (_, index) => textDelta(index, `part-${index}`))
const MESSAGE = assistantMessage(6, [0, 1, 2, 3, 4, 5])

describe('snapshot write-back layout', () => {
  it('writes a persisted log the canonicalizer accepts unchanged', () => {
    const written = scrubSessionSnapshot(persistedLog([[...RUN, MESSAGE]]))
    expect(canonicalSessionFixture(written, 'written.jsonl')).toBe(written)
  })

  it('expands storage range-encoded provenance into projected seq lists', () => {
    const written = scrubSessionSnapshot(persistedLog([[...RUN, MESSAGE]]))
    expect(written).toContain('"sourceEventSeqs":[0,1,2,3,4,5]')
  })

  it('writes a flush-split chunk run the canonicalizer accepts unchanged', () => {
    const written = scrubSessionSnapshot(persistedLog([RUN.slice(0, 3), [...RUN.slice(3), MESSAGE]]))
    expect(canonicalSessionFixture(written, 'written.jsonl')).toBe(written)
  })

  it('merges a chunk run the persistence flush boundary split into two rows', () => {
    const written = scrubSessionSnapshot(persistedLog([RUN.slice(0, 3), [...RUN.slice(3), MESSAGE]]))
    expect(written.split('\n').filter(line => line.includes('"text-chunks"'))).toHaveLength(1)
  })

  it('keeps the real inter-chunk gaps the committed corpus records', () => {
    const written = scrubSessionSnapshot(persistedLog([[...RUN, MESSAGE]]))
    expect(written).toContain('"dt":[1,1,1,1,1]')
  })
})

describe('isPhysicalSessionFixture', () => {
  it('recognizes fixtures that preserve physical persistence encoding', () => {
    expect(isPhysicalSessionFixture(
      'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/--dsh-workspace--/main/session.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/advanced/session.1.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/advanced/session.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/restart/session.2.jsonl',
    )).toBe(true)
    expect(isPhysicalSessionFixture(
      'packages/experimental/webworker-runtime/tests/fixtures/vfs-example/home/sessions/README.jsonl',
    )).toBe(false)
    expect(isPhysicalSessionFixture(
      'scripts/snapshots/python-sdk-single-exe/advanced/requests.jsonl',
    )).toBe(false)
    expect(isPhysicalSessionFixture('apps/web/tests/snapshots/example/session.jsonl')).toBe(false)
  })
})

it('keeps every session-format JSONL fixture projected into canonical packed layout', () => {
  const nonCanonical = inspectSessionFixtureLayouts(root)
    .filter(fixture => fixture.source !== fixture.canonical)
    .map(fixture => fixture.path)
  expect(
    nonCanonical,
    'Run `bun run migrate:packed-session-fixtures` and commit the mechanical fixture rewrite.',
  ).toEqual([])
})
