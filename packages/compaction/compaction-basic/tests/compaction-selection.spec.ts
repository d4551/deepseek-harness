import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/selection.ts'
import type { CompactRangeSelection } from '@deepseek-ai/dsh-compaction-basic/src/selection.ts'
import { frameSummary } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
} from '@deepseek-ai/dsh-compaction-basic/src/config.ts'
import { CompactionId, compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, { createMessage, createToolResultMessage, createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

const SIGNAL = new AbortController().signal
const MODEL = 'selection-model'
/** Retention budget so large it keeps the entire fixture surface verbatim. */
const ALL_RETAINED = 1_000_000
/** Summaries that never shrink their shadowed span. */
const OVERSIZED_SUMMARY: ContentBlock[] = [{ type: 'text', text: 'oversized '.repeat(2_000) }]
const SMALL_SUMMARY: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]

/** Manual-only engine config shared by the direct-construction tests. */
const DIRECT_CONFIG: BasicCompactionConfig = { auto: false, thresholdRatio: 0.5 }

/** A model service that reports one fixed context window and never streams text. */
class ScriptedModelService extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function selectionContext(contextWindow = 1_000): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter([MODEL], new ScriptedModelService(contextWindow))
  return ctx
}

function sessionAgent(session: Session): Agent {
  return { session, options: { provider: MODEL, model: MODEL } } as Agent
}

/** Closed user/assistant turns whose message text sizes to a fixed token count. */
function fixtureConversation(
  turns: number,
  leadingCheckpoints = 0,
  text = 'selection fixture '.repeat(20).trim(),
): Session {
  const session = Session.create(SessionId(`selection-conversation-${turns}`))
  for (let index = 0; index < leadingCheckpoints; index += 1) {
    appendCheckpoint(session, index)
  }
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `${text} user ${turn}` }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    if (turn === 1) {
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Append one framed compaction-checkpoint user message and return its seq. */
function appendCheckpoint(session: Session, index: number): number {
  const event = session.append('user/message', createUserMessage({
    content: [{
      type: 'text',
      text: `<compacted-summary>\ncheckpoint ${index}\n</compacted-summary>`,
    }],
    source: compactCheckpointSource(CompactionId(`selection-checkpoint-${index}`)),
  }), { surfaceOp: 'append' })
  return event.seq
}

/** An engine whose summarize hook pops scripted summaries in order. */
class ScriptedCompactionEngine extends BasicCompactionEngine {
  constructor(
    ctx: Context,
    config: BasicCompactionConfig,
    private readonly summaries: readonly ContentBlock[][],
    readonly calls: SummarizationInput[] = [],
  ) {
    super(ctx, config)
  }

  override async summarize(input: SummarizationInput): Promise<SummaryResult> {
    this.calls.push(input)
    const summary = this.summaries[this.calls.length - 1]
    if (summary === undefined) throw new Error('scripted summarizer exhausted')
    return { summary, provider: 'scripted', model: 'scripted' }
  }
}

/** Measure and select one range for the given fixture session. */
async function selectRange(session: Session, retain: number): Promise<CompactRangeSelection> {
  const ctx = await selectionContext()
  return selectCompactableRange(session, ctx.tokenMeter.measure(session), retain)
}

function expectRange(selection: CompactRangeSelection): asserts selection is Extract<CompactRangeSelection, { kind: 'range' }> {
  if (selection.kind !== 'range') throw new Error(`expected a range selection, got ${selection.kind}`)
}

/** Run one automatic pressure pass over a four-turn fixture and require a result. */
async function pressurePass(
  config: BasicCompactionConfig,
  summaries: readonly ContentBlock[][],
): Promise<{ engine: ScriptedCompactionEngine; session: Session; result: CompactionResult }> {
  const ctx = await selectionContext()
  const engine = new ScriptedCompactionEngine(ctx, { auto: false, ...config }, summaries)
  const session = fixtureConversation(4)
  const result = await engine.compactIfNeeded(sessionAgent(session), 'pressure', SIGNAL)
  if (result === null) throw new Error('pressure pass produced no compaction')
  return { engine, session, result }
}

describe('compaction target watermark', () => {
  it('resolves the default targetRatio into targetTokens below the threshold', () => {
    const config = resolveConfig({ thresholdRatio: 0.5 })
    expect(config.targetRatio).toBe(0.85)
    const policy = resolveTargetPolicy(config, { provider: MODEL, model: MODEL })
    const spec = resolveCompactSpec(policy, 1_000)
    expect(spec.thresholdTokens).toBe(500)
    expect(spec.targetTokens).toBe(425)
    expectTypeOf(spec.targetTokens).toEqualTypeOf<number>()
  })

  it('rejects ratio retention at or above the target fraction at load', () => {
    expect(() => resolveConfig({ thresholdRatio: 0.5, retainRatio: 0.45 }))
      .toThrow(/retainRatio \(0.45\) must be less than the resolved target fraction/)
    expect(() => resolveConfig({ thresholdRatio: 0.5, targetRatio: 0.9, retainRatio: 0.4 }))
      .not.toThrow()
  })

  it('rejects absolute retention at or above target tokens on first use', () => {
    const config = resolveConfig({ thresholdRatio: 0.5, retainTokens: 450 })
    const policy = resolveTargetPolicy(config, { provider: MODEL, model: MODEL })
    expect(() => resolveCompactSpec(policy, 1_000))
      .toThrow(/retainTokens \(450\) must be less than target tokens 425/)
  })
})

describe('checkpoint-aware range selection', () => {
  it('skips one leading checkpoint and consolidates two', async () => {
    const one = fixtureConversation(4, 1)
    const skip = await selectRange(one, 0)
    expectRange(skip)
    expect(skip.strategy).toBe('skip-checkpoint')
    expect(one.surface.nodes.indexOf(skip.start)).toBe(1)

    const two = fixtureConversation(4, 2)
    const consolidate = await selectRange(two, 0)
    expectRange(consolidate)
    expect(consolidate.strategy).toBe('consolidate')
    expect(consolidate.start).toBe(two.surface.nodes[0])
  })

  it('consolidates when the non-checkpoint span is below the minimum useful size', async () => {
    const session = fixtureConversation(1, 1)
    const checkpointSeq = session.surface.nodes[0]
    if (checkpointSeq === undefined) throw new Error('fixture surface empty')
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'tiny' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const selection = await selectRange(session, 0)
    expectRange(selection)
    expect(selection.strategy).toBe('consolidate')
    expect(selection.start).toBe(checkpointSeq)
  })

  it('declines when the checkpoint consumes the whole shadowable span', async () => {
    const ctx = await selectionContext()
    const session = fixtureConversation(1, 1)
    const measurement = ctx.tokenMeter.measure(session)
    const retainAfterCheckpoint = measurement.nodes
      .slice(1)
      .reduce((total, node) => total + node.tokens, 0)
    const selection = selectCompactableRange(session, measurement, retainAfterCheckpoint)
    expect(selection).toEqual({ kind: 'none', reason: 'checkpoint-only' })
  })

  it('scans a fully checkpointed surface to its end and declines', async () => {
    const session = Session.create(SessionId('all-checkpoints'))
    appendCheckpoint(session, 1)
    appendCheckpoint(session, 2)
    const selection = await selectRange(session, 0)
    expect(selection).toEqual({ kind: 'none', reason: 'checkpoint-only' })
  })

  it('names the reason when retention keeps the whole surface', async () => {
    const session = fixtureConversation(1)
    const selection = await selectRange(session, ALL_RETAINED)
    expect(selection).toEqual({ kind: 'none', reason: 'all-retained' })
  })
})

describe('hysteresis pressure loop', () => {
  it('keeps compacting past the threshold toward the target watermark', async () => {
    // Tune the first summary so its pass lands between the target (425) and
    // the threshold (500). The loop must then keep going: the next pass
    // consults selection again and, finding only the lone checkpoint
    // shadowable, reports the checkpoint-only reason instead of stopping
    // silently at the trigger.
    const ctx = await selectionContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => {
      warnings.push(message)
    }) as typeof ctx.logger.warn
    const session = fixtureConversation(4)
    const measurement = ctx.tokenMeter.measure(session)
    const tailTokens = measurement.nodes.slice(-3).reduce((total, node) => total + node.tokens, 0)
    let tunedSummary: ContentBlock[] | undefined
    for (let length = 64; length <= 16_384; length *= 2) {
      const candidate: ContentBlock[] = [{ type: 'text', text: 'x'.repeat(length) }]
      const framed = ctx.tokenMeter.estimateMessage(createUserMessage({
        content: frameSummary(candidate),
        source: { kind: 'plugin', plugin: 'test' },
      }))
      if (tailTokens + framed >= 425 && tailTokens + framed < 500) {
        tunedSummary = candidate
        break
      }
    }
    if (tunedSummary === undefined) throw new Error('no summary size lands between target and threshold')
    // A retention of 300 keeps exactly the last three fixture nodes: the walk
    // accumulates each node in turn and crosses the budget on the third.
    const engine = new ScriptedCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 300,
      compactionRetries: 1,
    }, [tunedSummary, SMALL_SUMMARY])

    const result = await engine.compactIfNeeded(sessionAgent(session), 'pressure', SIGNAL)

    expect(result).not.toBeNull()
    expect(engine.calls).toHaveLength(1)
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(500)
    expect(warnings).toContainEqual(expect.stringContaining('no compactable range (checkpoint-only)'))
  })

  it('stops at the first pass that reaches the target watermark', async () => {
    const { engine, session, result } = await pressurePass({
      thresholdRatio: 0.5,
      retainTokens: 200,
      compactionRetries: 1,
    }, [SMALL_SUMMARY, SMALL_SUMMARY])

    expect(engine.calls).toHaveLength(1)
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    const ctx = await selectionContext()
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(425)
  })
})

describe('shrink-failure retry', () => {
  it('consolidates on the next pass when the first summary does not shrink', async () => {
    const { engine } = await pressurePass({
      thresholdRatio: 0.5,
      retainTokens: 180,
      compactionRetries: 1,
    }, [OVERSIZED_SUMMARY, SMALL_SUMMARY])

    expect(engine.calls).toHaveLength(2)
  })

  it('rethrows the shrink error through compactIfNeeded when every pass fails', async () => {
    const ctx = await selectionContext()
    const engine = new ScriptedCompactionEngine(
      ctx,
      { ...DIRECT_CONFIG, retainTokens: 180, compactionRetries: 1 },
      [OVERSIZED_SUMMARY, OVERSIZED_SUMMARY],
    )
    const session = fixtureConversation(4)

    await expect(engine.compactIfNeeded(sessionAgent(session), 'pressure', SIGNAL))
      .rejects.toThrow(/summary is not smaller/)
    expect(engine.calls).toHaveLength(2)
  })
})

describe('selection diagnostics', () => {
  it('warns with the selection reason when pressure has no compactable range', async () => {
    const ctx = await selectionContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => {
      warnings.push(message)
    }) as typeof ctx.logger.warn
    const engine = new ScriptedCompactionEngine(ctx, { ...DIRECT_CONFIG, retainTokens: 0 }, [])
    const session = Session.create(SessionId('open-pair-pressure'))
    session.append('turn/start', { turn: 1 })
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
    session.append('step/start', { turn: 1, step: 1 })
    const hugeCall = ToolCallId('huge-call')
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: hugeCall, name: 'bash', arguments: 'x'.repeat(4_000) }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: hugeCall, name: 'bash', arguments: 'x'.repeat(4_000) })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('huge-call'),
        content: [{ type: 'text', text: 'done' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(500)

    await expect(engine.compactIfNeeded(sessionAgent(session), 'pressure', SIGNAL))
      .resolves.toEqual(null)
    expect(warnings).toContainEqual(expect.stringContaining('no compactable range (unbalanced)'))
  })

  it('leaves the surface unchanged when every pass fails to shrink', async () => {
    const ctx = await selectionContext()
    const engine = new ScriptedCompactionEngine(
      ctx,
      { ...DIRECT_CONFIG, retainTokens: 180, compactionRetries: 1 },
      [OVERSIZED_SUMMARY, OVERSIZED_SUMMARY],
    )
    const session = fixtureConversation(4)
    const before = [...session.surface.nodes]

    const failure = await engine.compactIfNeeded(sessionAgent(session), 'pressure', SIGNAL)
      .then(() => null, (error: unknown) => error)
    expect(failure).toMatchObject({ name: 'SummaryShrinkError' })
    expect(session.surface.nodes).toEqual(before)
    expect(engine.calls).toHaveLength(2)
  })
})
