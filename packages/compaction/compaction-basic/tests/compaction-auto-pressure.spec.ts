import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { toolPairingBalancedAfter, toolPairingBalancedBefore } from '@deepseek-ai/dsh-compaction'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  MODEL,
  TestCompactionEngine,
  agent,
  conversation,
  createContext,
  oversizedToolResult,
  overflow,
  preStep,
  recover,
  summarizedText,
  toolConversation,
} from './harness.ts'

/** Capture logger warnings into an array for assertion. */
function captureWarnings(ctx: Context): string[] {
  const warnings: string[] = []
  ctx.logger.warn = ((message: string) => {
    warnings.push(message)
  }) as typeof ctx.logger.warn
  return warnings
}

describe('automatic listener and loader composition', () => {
  it('compacts before a step above threshold using the durable routed model and remains idle below it', async () => {
    const ctx = await createContext()
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const pressured = conversation(4)
    await preStep(ctx, agent(pressured, 'unconfigured-agent-fallback'))
    expect(pressured.events.some(event => event.type === 'compaction/summary')).toBe(true)

    const small = conversation(1)
    await preStep(ctx, agent(small, MODEL))
    expect(small.events.some(event => event.type === 'compaction/start')).toBe(false)
    expect(compact.calls).toHaveLength(1)
  })

  it('skips pre-step pressure when the step signal is already aborted', async () => {
    const ctx = await createContext()
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const pressured = conversation(4)
    const compactIfNeeded = vi.spyOn(compact, 'compactIfNeeded')

    await expect(preStep(ctx, agent(pressured, MODEL), AbortSignal.abort('step aborted')))
      .resolves.toEqual({ kind: 'enter', messages: [] })

    expect(compactIfNeeded).not.toHaveBeenCalled()
    expect(pressured.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('warns and continues after operational failures, including non-Errors', async () => {
    const ctx = await createContext()
    const warnings = captureWarnings(ctx)
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    compact.error = 'temporary failure'
    const session = conversation(4)

    await expect(preStep(ctx, agent(session, MODEL))).resolves.toEqual({ kind: 'enter', messages: [] })
    expect(warnings).toContainEqual(expect.stringContaining('temporary failure'))
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('warns once per routed target when proactive pressure has no context metadata', async () => {
    const ctx = await createContext()
    const warnings = captureWarnings(ctx)
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({
      provider,
      id: model,
      name: model,
    }))
    new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)

    await preStep(ctx, agent(session, MODEL))
    await preStep(ctx, agent(session, MODEL))

    expect(warnings).toEqual([
      expect.stringContaining(`no context capacity for ${MODEL}/${MODEL}`),
    ])
  })

  it('warns once per routed target when absolute retention exceeds its resolved threshold', async () => {
    const ctx = await createContext()
    const warnings = captureWarnings(ctx)
    new TestCompactionEngine(ctx, {
      thresholdRatio: 0.5,
      retainTokens: 500,
    })
    const session = conversation(4)

    await preStep(ctx, agent(session, MODEL))
    await preStep(ctx, agent(session, MODEL))

    expect(warnings).toEqual([
      expect.stringContaining('retainTokens (500) must be less than threshold tokens 500'),
    ])
  })

  it('force-compacts below normal pressure for canonical overflow and retries only after replacement', async () => {
    const ctx = await createContext(10_000)
    new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = conversation(3)
    const beforeGeneration = session.surface.replaceGeneration
    const retainedSeq = session.surface.nodes.at(-1)
    if (retainedSeq === undefined) throw new Error('fixture surface empty')
    const threshold = 10_000
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(threshold)
    const decision = await recover(ctx, agent(session, 'unconfigured-agent-fallback'), overflow())

    expect(decision).toBe(true)
    expect(session.surface.replaceGeneration).toBe(beforeGeneration + 1)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(true)
    expect(session.surface.nodes).toContain(retainedSeq)
  })

  it('authorizes overflow retry when pruning alone advances an indivisible surface', async () => {
    const ctx = await createContext(10_000)
    await ctx.plugin(ToolResultPruner, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = oversizedToolResult()

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    expect(session.surface.replaceGeneration).toBe(1)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(false)
    expect(compact.calls).toHaveLength(0)
  })

  it('continues overflow recovery with summarization on the pruned surface', async () => {
    const ctx = await createContext(10_000)
    await ctx.plugin(ToolResultPruner, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    const session = toolConversation()

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    expect(session.events.some(event => event.type === 'compaction/summary')).toBe(true)
    expect(compact.calls).toHaveLength(1)
    const firstInput = compact.calls[0]?.input
    expect(firstInput === undefined ? '' : summarizedText(firstInput)).toContain('tool result middle pruned')
  })

  it('retries from a durable prune when later overflow summarization throws', async () => {
    const ctx = await createContext(10_000)
    const warnings = captureWarnings(ctx)
    await ctx.plugin(ToolResultPruner, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    compact.error = new Error('summary unavailable after prune')
    const session = oversizedToolResult(3_000, true)

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    expect(session.surface.replaceGeneration).toBe(1)
    expect(session.events.filter(event => event.type === 'tool/result')).toHaveLength(2)
    expect(session.events.findLast(event => event.type === 'compaction/end')?.data)
      .toMatchObject({ error: 'summary unavailable after prune' })
    expect(warnings).toContainEqual(expect.stringContaining('retrying from the replacement surface'))
  })

  it('lets cancellation win when summary throws after a durable prune', async () => {
    const ctx = await createContext(10_000)
    const controller = new AbortController()
    await ctx.plugin(ToolResultPruner, {
      thresholdChars: 100,
      headChars: 20,
      tailChars: 10,
    })
    const compact = new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 900,
    })
    compact.mutateDuringSummary = () => { controller.abort('cancelled during summary') }
    compact.error = new Error('summary cancelled after prune')
    const session = oversizedToolResult(3_000, true)

    expect(await recover(ctx, agent(session, MODEL), overflow(), controller.signal)).toBe(false)
    expect(session.surface.replaceGeneration).toBe(1)
  })

  it('preserves the newest whole tool-call/result pair during forced overflow compaction', async () => {
    const ctx = await createContext()
    new TestCompactionEngine(ctx, {
      thresholdRatio: 1,
      retainTokens: 90,
    })
    const session = toolConversation()
    const newestAssistant = session.surface.nodes.at(-2)
    const newestResult = session.surface.nodes.at(-1)
    if (newestAssistant === undefined || newestResult === undefined) throw new Error('fixture surface too small')

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(true)
    expect(session.surface.nodes).toContain(newestAssistant)
    expect(session.surface.nodes).toContain(newestResult)
    expect(toolPairingBalancedBefore(session, newestAssistant)).toBe(true)
    expect(toolPairingBalancedAfter(session, newestResult)).toBe(true)
  })
})
