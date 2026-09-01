import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import {
  MODEL,
  TestCompactionEngine,
  agent,
  conversation,
  createContext,
  overflow,
  preStep,
  recover,
} from './harness.ts'

describe('automatic overflow recovery and listener lifecycle', () => {
  it('does not retry when a backend reports success without replacing the surface', async () => {
    const ctx = await createContext()
    const compact = new TestCompactionEngine(ctx)
    const session = conversation(2)
    const fakeResult: CompactionResult = {
      compactionId: CompactionId('fake-compaction'),
      startSeq: 1,
      summarySeq: 2,
      endSeq: 3,
      summary: [{ type: 'text', text: 'fake' }],
      shadowedRange: { start: 1, end: 2 },
      shadowedSeqs: [1, 2],
      shadowedTokenCount: 10,
    }
    vi.spyOn(compact, 'compactIfNeeded').mockResolvedValue(fakeResult)

    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
    expect(session.surface.replaceGeneration).toBe(0)
  })

  it('delegates downstream exactly once when no replacement is available', async () => {
    const ctx = await createContext()
    const compact = new TestCompactionEngine(ctx)
    vi.spyOn(compact, 'compactIfNeeded').mockResolvedValue(null)
    const downstream = new Error('downstream recovery failed')
    let calls = 0

    await expect(recover(
      ctx,
      agent(conversation(2), MODEL),
      overflow(),
      new AbortController().signal,
      () => {
        calls += 1
        return Promise.reject(downstream)
      },
    )).rejects.toBe(downstream)
    expect(calls).toBe(1)
  })

  it('preserves the original provider error when recovery throws', async () => {
    const ctx = await createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => {
      warnings.push(message)
    }) as typeof ctx.logger.warn
    const compact = new TestCompactionEngine(ctx)
    compact.error = new Error('summary unavailable')
    const original = overflow('original provider overflow')

    expect(await recover(ctx, agent(conversation(3), MODEL), original)).toBe(false)
    expect(original).toMatchObject({
      message: 'original provider overflow',
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
    })
    expect(warnings).toContainEqual(expect.stringContaining('preserving the original request error'))
  })

  it('delegates once when overflow recovery throws a non-Error value', async () => {
    const ctx = await createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => {
      warnings.push(message)
    }) as typeof ctx.logger.warn
    const compact = new TestCompactionEngine(ctx)
    compact.error = 'non-error recovery failure'
    const session = conversation(3)
    const generation = session.surface.replaceGeneration
    const original = overflow('original provider failure')
    let delegations = 0

    const decision = await recover(ctx, agent(session, MODEL), original, new AbortController().signal, () => {
      delegations += 1
      return Promise.resolve(undefined)
    })

    expect(decision).toBe(false)
    expect(delegations).toBe(1)
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(original).toMatchObject({
      message: 'original provider failure',
      code: CONTEXT_WINDOW_EXCEEDED_CODE,
    })
    expect(warnings).toContainEqual(expect.stringContaining('non-error recovery failure'))
  })

  it('wraps a number thrown by overflow recovery into the durable error chain', async () => {
    const ctx = await createContext()
    const warnings: string[] = []
    ctx.logger.warn = ((message: string) => {
      warnings.push(message)
    }) as typeof ctx.logger.warn
    const compact = new TestCompactionEngine(ctx)
    compact.error = 42
    const session = conversation(3)
    const original = overflow('original provider failure')

    expect(await recover(ctx, agent(session, MODEL), original)).toBe(false)
    expect(warnings).toContainEqual(expect.stringContaining('42'))
  })

  it('recovers an overflow for an unlisted routed model', async () => {
    const ctx = await createContext()
    new TestCompactionEngine(ctx)
    const session = conversation(2)
    session.append('request/header', {
      header: { config: { provider: 'unknown-routed-provider', model: 'unknown-routed-model' } },
      reason: 'resume',
    })
    expect(await recover(ctx, agent(session, MODEL), overflow('unlisted-model overflow')))
      .toBe(true)
  })

  it('delegates canonical overflow when no durable routed target exists', async () => {
    const ctx = await createContext()
    new TestCompactionEngine(ctx)
    const session = Session.create(SessionId('headerless-overflow'))
    session.append('turn/start', {
      turn: 1,
    })

    await expect(recover(ctx, agent(session, MODEL), overflow())).resolves.toBe(false)
  })

  it('honors retry caps and ignores non-context failures', async () => {
    const ctx = await createContext()
    const compact = new TestCompactionEngine(ctx, { maxOverflowRetries: 1 })
    const compactSpy = vi.spyOn(compact, 'compactIfNeeded')
    const owner = agent(conversation(3), MODEL)
    expect(await recover(ctx, owner, Object.assign(new Error('rate limit'), { code: 'RATE_LIMIT' })))
      .toBe(false)
    expect(await recover(ctx, owner, overflow())).toBe(true)
    compactSpy.mockClear()
    expect(await recover(ctx, owner, overflow())).toBe(false)
    expect(compactSpy).not.toHaveBeenCalled()
  })

  it('applies the routed model override to the overflow retry cap', async () => {
    const ctx = await createContext()
    const compact = new TestCompactionEngine(ctx, {
      maxOverflowRetries: 2,
      modelPolicies: [{
        provider: MODEL,
        model: MODEL,
        maxOverflowRetries: 1,
      }],
    })
    const compactSpy = vi.spyOn(compact, 'compactIfNeeded')
    const owner = agent(conversation(3), MODEL)

    expect(await recover(ctx, owner, overflow())).toBe(true)
    compactSpy.mockClear()
    expect(await recover(ctx, owner, overflow())).toBe(false)
    expect(compactSpy).not.toHaveBeenCalled()
  })

  it('does not retry when cancellation lands during an awaited compaction', async () => {
    const ctx = await createContext()
    const compact = new TestCompactionEngine(ctx)
    const controller = new AbortController()
    compact.mutateDuringSummary = () => { controller.abort('cancelled during summary') }
    const session = conversation(3)
    const generation = session.surface.replaceGeneration

    expect(await recover(ctx, agent(session, MODEL), overflow(), controller.signal)).toBe(false)
    expect(session.surface.replaceGeneration).toBe(generation + 1)
  })

  it('maxOverflowRetries:0 disables recovery without disabling post-step pressure', async () => {
    const ctx = await createContext()
    new TestCompactionEngine(ctx, {
      maxOverflowRetries: 0,
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    const summaries = session.events.filter(event => event.type === 'compaction/summary').length
    expect(summaries).toBe(1)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
    expect(session.events.filter(event => event.type === 'compaction/summary')).toHaveLength(summaries)
  })

  it('auto:false installs neither automatic listener', async () => {
    const ctx = await createContext()
    new TestCompactionEngine(ctx, {
      auto: false,
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
  })

  it('loads and disposes the real zero-config service stack', async () => {
    const ctx = new Context()
    const LlmRuntime = (await import('@deepseek-ai/dsh-llm')).default
    const SessionStore = (await import('@deepseek-ai/dsh-session')).default
    const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    const meterFiber = await ctx.plugin(TokenMeter)
    const compactFiber = await ctx.plugin(BasicCompactionEngine, { auto: false })

    expect(ctx.get('compaction')).toBeInstanceOf(BasicCompactionEngine)
    await compactFiber.dispose()
    expect(ctx.get('compaction')).toBeUndefined()
    await meterFiber.dispose()
    expect(ctx.get('tokenMeter')).toBeUndefined()
  })

  it('removes its automatic listener with the plugin fiber', async () => {
    const ctx = new Context()
    const LlmRuntime = (await import('@deepseek-ai/dsh-llm')).default
    const TokenMeter = (await import('@deepseek-ai/dsh-token-meter')).default
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    const fiber = await ctx.plugin(TestCompactionEngine, {
      thresholdRatio: 0.5,
      retainTokens: 180,
    })
    await fiber.dispose()

    const session = conversation(4)
    await preStep(ctx, agent(session, MODEL))
    expect(session.events.some(event => event.type === 'compaction/start')).toBe(false)
    expect(await recover(ctx, agent(session, MODEL), overflow())).toBe(false)
  })
})
