import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import {
  MODEL,
  TestCompactionEngine,
  agent,
  conversation,
  createContext,
  service,
  summarizedText,
  toolConversation,
} from './harness.ts'

describe('compaction region transaction', () => {
  let compact: TestCompactionEngine

  beforeEach(async () => {
    compact = await service()
  })

  it('lands a framed, replayable checkpoint with exact source seqs and token price', async () => {
    compact.rawOutput = [
      { type: 'reasoning', text: 'private compact thought' },
      ...compact.summary,
    ]
    compact.usage = { inputTokens: 40, outputTokens: 5 }
    const session = conversation(3)
    const before = [...session.surface.nodes]
    const start = before[0]
    const end = before[3]
    if (start === undefined || end === undefined) throw new Error('fixture surface too small')
    const signal = new AbortController().signal
    const result = await compact.compactRegion(
      start,
      end,
      agent(session, MODEL),
      signal,
    )

    expect(result.shadowedSeqs).toEqual(before.slice(0, 4))
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(compact.calls[0]).toMatchObject({ signal })
    const firstInput = compact.calls[0]?.input
    expect(firstInput === undefined ? '' : summarizedText(firstInput)).toContain('fixture user 1')
    const summary = session.events.findLast(event => event.type === 'compaction/summary')
    expect(summary?.data).toMatchObject({
      shadowedSeqs: result.shadowedSeqs,
      shadowedTokenCount: result.shadowedTokenCount,
      provider: 'summary-provider',
      model: 'summary-model',
      maxTokens: 123,
      rawOutput: compact.rawOutput,
      usage: compact.usage,
    })
    expect(summary?.data).not.toHaveProperty('llmStreamCall')
    const head = session.deriveMessages()[0]
    expect(head?.content[0]?.type).toBe('text')
    expect(head?.content[0]?.type === 'text' ? head.content[0].text : '').toContain('<compacted-summary>')
    expect(head?.content.at(-1)).toEqual({ type: 'text', text: '</compacted-summary>' })

    const replay = Session.create(SessionId('replay'), [...session.events])
    expect(replay.deriveMessages()).toEqual(session.deriveMessages())
  })

  it('replays the latest routed header so the summarizer reuses the cache', async () => {
    const session = conversation(3)
    const tools = [{ name: 'do_thing', description: 'd', parameters: { type: 'object' } }]
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'CONVERSATION SYSTEM', tools },
      reason: 'resume',
    })
    const nodes = session.surface.nodes
    const first = nodes[0]
    const second = nodes[1]
    if (first === undefined || second === undefined) throw new Error('fixture surface too small')
    await compact.compactRegion(first, second, agent(session, MODEL), new AbortController().signal)

    const input = compact.calls[0]?.input
    expect(input?.system).toBe('CONVERSATION SYSTEM')
    expect(input?.tools).toEqual(tools)
    expect(input === undefined ? '' : summarizedText(input)).toContain('fixture user 1')
  })

  it.each([
    ['start missing', 9_001, undefined, /start seq 9001 not found/],
    ['end missing', undefined, 9_002, /end seq 9002 not found/],
  ])('rejects %s', async (_label, startOverride, endOverride, pattern) => {
    const session = conversation(2)
    const nodes = session.surface.nodes
    const first = nodes[0]
    const second = nodes[1]
    if (first === undefined || second === undefined) throw new Error('fixture surface too small')
    await expect(compact.compactRegion(
      startOverride ?? first,
      endOverride ?? second,
      agent(session, MODEL),
    )).rejects.toThrow(pattern)
  })

  it('rejects reversed and tool-unbalanced positional boundaries', async () => {
    const plain = conversation(2)
    const nodes = plain.surface.nodes
    const second = nodes[1]
    const third = nodes[2]
    if (second === undefined || third === undefined) throw new Error('fixture surface too small')
    await expect(compact.compactRegion(
      third,
      second,
      agent(plain, MODEL),
    )).rejects.toThrow(/is after end/)

    const tools = toolConversation()
    const toolNodes = tools.surface.nodes
    const toolThird = toolNodes[2]
    const toolFifth = toolNodes[4]
    const toolFirst = toolNodes[0]
    const toolSecond = toolNodes[1]
    if (toolThird === undefined || toolFifth === undefined
      || toolFirst === undefined || toolSecond === undefined) {
      throw new Error('fixture surface too small')
    }
    await expect(compact.compactRegion(
      toolThird,
      toolFifth,
      agent(tools, MODEL),
    )).rejects.toThrow(/start seq .* not a balanced boundary/)
    await expect(compact.compactRegion(
      toolFirst,
      toolSecond,
      agent(tools, MODEL),
    )).rejects.toThrow(/end seq .* not a balanced boundary/)
  })

  it('requires an open turn and an idle compaction bracket', async () => {
    const closed = conversation(1)
    closed.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
    const closedNodes = closed.surface.nodes
    const closedFirst = closedNodes[0]
    const closedSecond = closedNodes[1]
    if (closedFirst === undefined || closedSecond === undefined) throw new Error('fixture surface too small')
    await expect(compact.compactRegion(
      closedFirst,
      closedSecond,
      agent(closed, MODEL),
    )).rejects.toThrow(/no open turn/)

    const locked = conversation(1)
    locked.append('compaction/start', {
      compactionId: CompactionId('locked-compaction'),
      turn: 2,
    })
    const lockedNodes = locked.surface.nodes
    const lockedFirst = lockedNodes[0]
    const lockedSecond = lockedNodes[1]
    if (lockedFirst === undefined || lockedSecond === undefined) throw new Error('fixture surface too small')
    await expect(compact.compactRegion(
      lockedFirst,
      lockedSecond,
      agent(locked, MODEL),
    )).rejects.toThrow(/already in progress/)
  })

  it('rejects a session with no turn boundary at all', async () => {
    const session = Session.create(SessionId('turnless'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'orphan' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const node = session.surface.nodes[0]
    if (node === undefined) throw new Error('fixture surface too small')

    await expect(compact.compactRegion(
      node,
      node,
      agent(session, MODEL),
    )).rejects.toThrow(/no open turn/)
  })

  it('rejects a meter snapshot that changed before summarization began', async () => {
    const ctx = await createContext()
    const meter = ctx.tokenMeter
    const original = meter.measure.bind(meter)
    vi.spyOn(meter, 'measure').mockImplementationOnce((session) => {
      const measurement = original(session)
      return { ...measurement, nodes: measurement.nodes.slice(1) }
    })
    compact = await service({ auto: false }, ctx)
    const session = conversation(2)
    const nodes = session.surface.nodes
    const first = nodes[0]
    const third = nodes[2]
    if (first === undefined || third === undefined) throw new Error('fixture surface too small')

    await expect(compact.compactRegion(
      first,
      third,
      agent(session, MODEL),
    )).rejects.toThrow(/selected surface changed/)
  })

  it('records summarizer failures without mutating the surface', async () => {
    compact.error = new Error('summary unavailable')
    const session = conversation(2)
    const before = session.surface.nodes
    const first = before[0]
    const third = before[2]
    if (first === undefined || third === undefined) throw new Error('fixture surface too small')

    await expect(compact.compactRegion(
      first,
      third,
      agent(session, MODEL),
    )).rejects.toThrow('summary unavailable')
    expect(session.surface.nodes).toEqual(before)
    expect(session.events.findLast(event => event.type === 'compaction/end')?.data)
      .toMatchObject({ error: 'summary unavailable' })
  })

  it('captures a non-Error failure as an Error and records its rendering', async () => {
    compact.error = 'plain failure'
    const session = conversation(2)
    const nodes = session.surface.nodes
    const first = nodes[0]
    const third = nodes[2]
    if (first === undefined || third === undefined) throw new Error('fixture surface too small')
    await expect(compact.compactRegion(
      first,
      third,
      agent(session, MODEL),
    )).rejects.toThrow(new Error('plain failure'))
    expect(session.events.findLast(event => event.type === 'compaction/end')?.data)
      .toMatchObject({ error: 'plain failure' })
  })

  it('tolerates concurrent log-only appends while the selected surface is stable', async () => {
    const session = conversation(2)
    compact.mutateDuringSummary = () => {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'change',
      })
    }
    const nodes = session.surface.nodes
    const first = nodes[0]
    const third = nodes[2]
    if (first === undefined || third === undefined) throw new Error('fixture surface too small')

    await expect(compact.compactRegion(
      first,
      third,
      agent(session, MODEL),
    )).resolves.toMatchObject({ shadowedSeqs: nodes.slice(0, 3) })
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(true)
  })

  it('rejects concurrent surface appends before committing the replacement', async () => {
    const session = conversation(2)
    compact.mutateDuringSummary = () => {
      session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'concurrent surface mutation' }],
        source: { kind: 'plugin', plugin: 'test' },
      }), { surfaceOp: 'append' })
    }
    const nodes = session.surface.nodes
    const first = nodes[0]
    const third = nodes[2]
    if (first === undefined || third === undefined) throw new Error('fixture surface too small')

    await expect(compact.compactRegion(
      first,
      third,
      agent(session, MODEL),
    )).rejects.toThrow(/session surface changed/)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('rejects a non-shrinking framed summary under the conversation meter', async () => {
    compact.summary = Array.from({ length: 100 }, (_, index) => ({
      type: 'text',
      text: `verbose ${index}`,
    }))
    const session = conversation(2)
    const nodes = session.surface.nodes
    const first = nodes[0]
    const third = nodes[2]
    if (first === undefined || third === undefined) throw new Error('fixture surface too small')

    await expect(compact.compactRegion(
      first,
      third,
      agent(session, MODEL),
    )).rejects.toThrow(/summary is not smaller/)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('lets a model-independent custom summarizer compact without a conversation model', async () => {
    const session = Session.create(SessionId('model-less-region'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'history '.repeat(100) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'answer '.repeat(100) }],
        source: { kind: 'model', provider: 'historical', model: 'historical' },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const nodes = session.surface.nodes
    const first = nodes[0]
    const second = nodes[1]
    if (first === undefined || second === undefined) throw new Error('fixture surface too small')
    await expect(compact.compactRegion(
      first,
      second,
      agent(session),
    )).resolves.toMatchObject({ shadowedSeqs: [first, second] })
  })
})
