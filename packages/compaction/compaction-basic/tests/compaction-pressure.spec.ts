import { describe, expect, it, vi, beforeEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { selectCompactableRange } from '@deepseek-ai/dsh-compaction-basic/src/selection.ts'
import LlmRuntime, { createMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import ToolResultPruner from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  MODEL,
  RoutedContextModelService,
  TestCompactionEngine,
  agent,
  compactIfNeeded,
  conversation,
  createContext,
  oversizedToolResult,
  service,
  summarizedText,
  toolConversation,
} from './harness.ts'

describe('pressure measurement and retention', () => {
  const compactConfig: BasicCompactionConfig = {
    auto: false,
    thresholdRatio: 0.5,
    retainTokens: 180,
  }
  let compact: TestCompactionEngine

  beforeEach(async () => {
    compact = await service(compactConfig)
  })

  it('skips when no durable routed model exists instead of using AgentOptions', async () => {
    const session = Session.create(SessionId('headerless'))
    session.append('turn/start', { turn: 1 })
    await expect(compact.compactIfNeeded(agent(session, MODEL), 'pressure', new AbortController().signal))
      .resolves.toBeNull()
    expect(compact.calls).toHaveLength(0)
  })

  it('meters an unlisted model when its provider service supplies context metadata', async () => {
    const session = conversation()
    session.append('request/header', {
      header: { config: { provider: 'unlisted-provider', model: 'unlisted-model' } },
      reason: 'resume',
    })
    await expect(compactIfNeeded(compact, session))
      .resolves.not.toBeNull()
  })

  it('forwards turn cancellation to proactive model metadata resolution', async () => {
    const ctx = await createContext()
    const resolveModelInfo = vi.spyOn(ctx.llm, 'resolveModelInfo')
    const compact = await service(compactConfig, ctx)
    const session = conversation()
    const signal = new AbortController().signal

    await expect(compact.compactIfNeeded(agent(session, MODEL), 'pressure', signal))
      .resolves.not.toBeNull()
    expect(resolveModelInfo).toHaveBeenCalledWith(MODEL, MODEL, signal)
  })

  it('re-resolves capacity after a same-model-id provider switch in one session', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    ctx.llm.registerAdapter(['large', 'small'], new RoutedContextModelService({
      large: 10_000,
      small: 1_000,
    }))
    const compact = await service({
      auto: false,
      thresholdRatio: 0.5,
      retainRatio: 0.1,
    }, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: 'large', model: 'shared-id' } },
      reason: 'resume',
    })
    await expect(compactIfNeeded(compact, session)).resolves.toBeNull()

    session.append('request/header', {
      header: { config: { provider: 'small', model: 'shared-id' } },
      reason: 'change',
    })
    await expect(compactIfNeeded(compact, session)).resolves.not.toBeNull()
  })

  it('requires capacity only for proactive pressure, not provider-confirmed overflow', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    ctx.llm.registerAdapter(['unknown-context'], new RoutedContextModelService({}))
    vi.spyOn(ctx.llm, 'resolveModelInfo').mockImplementation((provider, model) => Promise.resolve({
      provider,
      id: model,
      name: model,
    }))
    const compact = await service(compactConfig, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: 'unknown-context', model: 'model' } },
      reason: 'resume',
    })

    await expect(compactIfNeeded(compact, session, 'pressure'))
      .rejects.toThrow(/no context capacity for unknown-context\/model/)
    await expect(compactIfNeeded(compact, session, 'context-overflow'))
      .resolves.not.toBeNull()
  })

  it('declines forced overflow when the whole surface is one indivisible tool pair', async () => {
    const compact = await service(compactConfig)
    const session = Session.create(SessionId('single-tool-pair'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL } },
      reason: 'initial',
    })
    const callId = ToolCallId('single-call')
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })
    const generation = session.surface.replaceGeneration

    await expect(compactIfNeeded(compact, session, 'context-overflow')).resolves.toBeNull()
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('does nothing below threshold and compacts a priced head above threshold', async () => {
    const compact = await service(compactConfig)
    expect(await compactIfNeeded(compact, conversation(2))).toBeNull()

    const session = conversation(4)
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()
    expect(result?.shadowedSeqs.length).toBeGreaterThan(2)
    expect(session.surface.nodes.length).toBeLessThan(8)
  })

  it('counts the durable routed request envelope without putting it on the surface', async () => {
    const compact = await service({
      auto: false,
      thresholdRatio: 0.9,
      retainTokens: 50,
    })
    const session = conversation(2, 'x'.repeat(600))
    expect(await compactIfNeeded(compact, session)).toBeNull()

    session.append('request/header', {
      header: {
        config: { provider: MODEL, model: MODEL },
        system: 's'.repeat(2_000),
      },
      reason: 'resume',
    })
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()
  })

  it('uses the latest logged request envelope without an AgentOptions override', async () => {
    const ctx = await createContext()
    const compact = await service({
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 180,
    }, ctx)
    const session = conversation(4)
    session.append('request/header', {
      header: { config: { provider: 'actual', model: 'actual' } },
      reason: 'initial',
    })
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')

    const result = await compactIfNeeded(compact, session, 'pressure', 'fallback')
    expect(result).not.toBeNull()
    expect(session.requestHeader()?.config.model).toBe('actual')
    expect(measure.mock.calls[0]).toEqual([session])
  })

  it('declines when envelope pressure is high but the surface has no compactable range', async () => {
    const compact = await service(compactConfig)
    const empty = Session.create(SessionId('empty'))
    empty.append('turn/start', { turn: 1 })
    empty.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'x'.repeat(100_000) },
      reason: 'initial',
    })
    expect(await compactIfNeeded(compact, empty)).toBeNull()

    const retained = conversation(1)
    retained.append('request/header', {
      header: { config: { provider: MODEL, model: MODEL }, system: 'x'.repeat(100_000) },
      reason: 'resume',
    })
    expect(await compactIfNeeded(compact, retained)).toBeNull()
  })

  it('uses one unified measurement for each pressure-and-retention decision', async () => {
    const ctx = await createContext()
    const compact = await service(compactConfig, ctx)
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')
    const stop = new Error('stop after first decision')
    vi.spyOn(compact, 'compactRegion').mockRejectedValueOnce(stop)

    await expect(compactIfNeeded(compact, conversation(4))).rejects.toBe(stop)
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('bounds retries when a shrinking checkpoint remains above threshold', async () => {
    const compact = await service({
      auto: false,
      compactionRetries: 0,
      thresholdRatio: 0.3,
      retainTokens: 180,
    })
    compact.summary = Array.from({ length: 7 }, (_, index) => ({
      type: 'text',
      text: `summary ${index}`,
    }))

    await expect(compactIfNeeded(compact, conversation(4)))
      .rejects.toThrow(/still above threshold after 1 compaction attempts/)
  })

  it('rounds a retention cut head-ward to preserve tool-call/result pairing', async () => {
    const compact = await service({
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 80,
    }, await createContext(4_000))
    const session = toolConversation()
    const result = await compactIfNeeded(compact, session)
    expect(result).not.toBeNull()

    const messages = session.deriveMessages()
    const calls = new Set<string>()
    for (const message of messages) {
      for (const block of message.content) {
        if (block.type === 'tool-call') calls.add(block.id)
        if (block.type === 'tool-result') expect(calls.has(block.toolCallId)).toBe(true)
      }
    }
  })

  it('rejects a priced surface that is not the current positional surface', async () => {
    const ctx = await createContext()
    const session = conversation(2)
    const priced = ctx.tokenMeter.measure(session)
    expect(() => selectCompactableRange(session, {
      ...priced,
      nodes: priced.nodes.slice(1),
    }, 1)).toThrow(/does not match/)
  })

  it('declines when rounding a cut would consume the only tool pair', async () => {
    const ctx = await createContext()
    const session = Session.create(SessionId('one-tool-pair'))
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    const callId = ToolCallId('only')
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{}' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: 'result' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn: 1, step: 1 })

    const priced = ctx.tokenMeter.measure(session)
    const selection = selectCompactableRange(session, priced, 1)
    expect(selection.kind).toBe('none')
    expect(selection.kind === 'none' && selection.reason).toBe('unbalanced')
  })
})

describe('optional model-free tool-result pruning', () => {
  const pruneConfig = { thresholdChars: 100, headChars: 20, tailChars: 10 }

  it('does not prune a below-pressure session opportunistically', async () => {
    const ctx = await createContext(10_000)
    const prune = new ToolResultPruner(ctx, pruneConfig)
    const compact = await service({
      auto: false,
      thresholdRatio: 0.8,
      retainTokens: 100,
    }, ctx)
    const session = oversizedToolResult()
    const pruneSession = vi.spyOn(prune, 'pruneSession')

    expect(await compactIfNeeded(compact, session)).toBeNull()
    expect(pruneSession).not.toHaveBeenCalled()
    expect(compact.calls).toHaveLength(0)
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it('skips LLM summarization when pruning alone clears pressure', async () => {
    const ctx = await createContext(1_000)
    await ctx.plugin(ToolResultPruner, pruneConfig)
    const compact = await service({
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    }, ctx)
    const session = oversizedToolResult()

    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(500)
    expect(await compactIfNeeded(compact, session)).toBeNull()
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeLessThan(500)
    expect(compact.calls).toHaveLength(0)
    expect(session.surface.replaceGeneration).toBe(1)
  })

  it('summarizes the pruned surface when pruning is insufficient', async () => {
    const ctx = await createContext(2_000)
    await ctx.plugin(ToolResultPruner, pruneConfig)
    const compact = await service({
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    }, ctx)
    const session = toolConversation()

    expect(await compactIfNeeded(compact, session)).not.toBeNull()
    expect(compact.calls).toHaveLength(1)
    const firstInput = compact.calls[0]?.input
    expect(firstInput === undefined ? '' : summarizedText(firstInput)).toContain('tool result middle pruned')
    expect(firstInput === undefined ? '' : summarizedText(firstInput)).not.toContain('result 1 '.repeat(300))
  })

  it('retains the original compaction-basic behavior without the optional plugin', async () => {
    const ctx = await createContext(2_000)
    const compact = await service({
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 50,
    }, ctx)
    const session = oversizedToolResult(3_000, true)

    expect(await compactIfNeeded(compact, session)).not.toBeNull()
    expect(compact.calls).toHaveLength(1)
    const original = session.events.find(event => event.type === 'tool/result')
    expect(original?.type === 'tool/result' && original.data.message.content[0]?.content[0])
      .toEqual({ type: 'text', text: 'X'.repeat(3_000) })
    expect(session.events.filter(event =>
      event.type === 'tool/result' && event.surfaceOp !== 'append')).toHaveLength(0)
  })
})
