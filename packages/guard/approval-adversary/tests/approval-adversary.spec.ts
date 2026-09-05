/**
 * Behavior suite for the adversarial approval answerer: the opt-in policy,
 * the logged review request, verdict handling, the two fallbacks, and the
 * notices the model receives.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as ApprovalAdversary from '../src/index.ts'

/** The plugin's composition config, named through `apply` so the schema value of the same name cannot shadow it. */
type AdversaryConfig = NonNullable<Parameters<typeof ApprovalAdversary.apply>[1]>

const NS = String(ApprovalAdversary.APPROVAL_ADVERSARY_SETTINGS_NAMESPACE)

/** One scripted reply, or a generator driving the stream by hand. */
type ScriptEntry = StreamChunk[] | 'hang' | ((options: GenerateOptions) => AsyncGenerator<StreamChunk>)

/** Scripted reviewer adapter: each model call consumes the next entry and records its request. */
class ReviewAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (entry === undefined) throw new Error('review adapter script exhausted')
    if (entry === 'hang') {
      throw await new Promise<unknown>((resolve) => {
        options.signal?.addEventListener('abort', () => { resolve(options.signal?.reason) }, { once: true })
      })
    }
    if (typeof entry === 'function') {
      yield * entry(options)
      return
    }
    for (const chunk of entry) yield chunk
  }
}

/** One complete text reply ending with the given finish reason. */
function reply(text: string, finish: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    finish,
  ]
}

const ALLOW = reply('VERDICT: ALLOW\nREASON: the command rebuilds exactly what the user asked for')
const DENY = reply('VERDICT: DENY\nREASON: disabling the suite hides failures instead of fixing them')

/** Writable provider used to verify the Host settings seam and live reloads. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, config: { doc?: Record<string, unknown> } = {}) {
    super(ctx)
    this.doc = structuredClone(config.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }

  pushExternal(doc: Record<string, unknown>): void {
    this.doc = structuredClone(doc)
    this.publish(structuredClone(doc))
  }
}

interface SeedOptions {
  /** A human instruction to log first. */
  instruction?: string
  /** The route of a logged request header. */
  route?: { provider: string; model: string }
  /** A logged tool call the question can be about. */
  call?: { id: string; name: string; arguments: string }
  /** A plugin-authored user message logged after the instruction. */
  pluginMessage?: string
}

/** Minimal agent stand-in with a real session; `inject` appends directly. */
function sessionAgent(id: string, seed: SeedOptions = {}): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  if (seed.instruction !== undefined) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: seed.instruction }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
  }
  if (seed.pluginMessage !== undefined) {
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: seed.pluginMessage }],
      source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })
  }
  if (seed.route !== undefined) {
    session.append('request/header', { header: { config: seed.route }, reason: 'initial' })
  }
  if (seed.call !== undefined) {
    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId(seed.call.id), name: seed.call.name, arguments: seed.call.arguments,
    })
  }
  return {
    id,
    session,
    inject(message: Parameters<Agent['inject']>[0]) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as Agent
}

const EXPLICIT = { enabled: true, provider: 'reviewer', model: 'adversary' } satisfies AdversaryConfig

/** Mount the approval service, the LLM runtime, and the adversary over a scripted reviewer. */
async function harness(config: AdversaryConfig = EXPLICIT, script: ScriptEntry[] = []) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ApprovalAdversary, config)
  const adapter = new ReviewAdapter(script)
  ctx.llm.registerAdapter(['reviewer', 'agent-route'], adapter)
  return { ctx, adapter }
}

/** Mount the adversary with a real in-memory settings provider. */
async function settingsHarness(config: AdversaryConfig = {}, script: ScriptEntry[] = []) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(MemorySettings, {})
  await ctx.plugin(ApprovalAdversary, config)
  const adapter = new ReviewAdapter(script)
  ctx.llm.registerAdapter(['reviewer', 'agent-route'], adapter)
  return { ctx, adapter, provider: ctx.settings as MemorySettings }
}

/** The notices this plugin injected into one session, in log order. */
function notices(events: readonly SessionEvent[]): { summary: string; text: string }[] {
  return events.flatMap((event) => {
    if (event.type !== 'user/message') return []
    const message = event.data as UserMessage & { source: { plugin?: string; summary?: string } }
    if (message.source.plugin !== 'approval-adversary') return []
    return [{
      summary: message.source.summary ?? '',
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    }]
  })
}

/** The logged review requests, in log order. */
function loggedReviews(events: readonly SessionEvent[]): SessionEvent<'approval/adversary-request'>[] {
  return events.filter(
    (event): event is SessionEvent<'approval/adversary-request'> => event.type === 'approval/adversary-request',
  )
}

/** The logged review request, which must exist exactly once. */
function loggedReview(events: readonly SessionEvent[]): ApprovalAdversary.ApprovalAdversaryRequestEventData {
  const reviews = loggedReviews(events)
  expect(reviews).toHaveLength(1)
  return reviews[0]!.data
}

/** The JSON record the reviewer read. */
function reviewedRecord(options: GenerateOptions): Record<string, unknown> {
  const text = options.messages[0]!.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  expect(text.startsWith('Decide this approval request from the JSON record:\n')).toBe(true)
  return JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>
}

describe('policy', () => {
  it('delegates every request while disabled, the shipped default', async () => {
    const { ctx, adapter } = await harness({})
    const agent = sessionAgent('disabled', { route: { provider: 'agent-route', model: 'm' } })
    let downstream = 0
    ctx.on('approval/request', () => {
      downstream += 1
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('allowed-once')

    expect(downstream).toBe(1)
    expect(adapter.requests).toEqual([])
    expect(notices(agent.session.events)).toEqual([])
  })

  it('rejects a half-specified route at mount', () => {
    expect(() => { ApprovalAdversary.apply(new Context(), { provider: 'reviewer' }) })
      .toThrow('approval-adversary: provider and model must be supplied together')
    expect(() => { ApprovalAdversary.apply(new Context(), { model: 'adversary' }) })
      .toThrow('approval-adversary: provider and model must be supplied together')
    expect(() => { ApprovalAdversary.apply(new Context()) }).not.toThrow()
  })

  it('serves the shipped policy as a settings section and refuses a half-specified route', async () => {
    const { ctx, provider } = await settingsHarness()

    const descriptor = ctx.settings.describe().find(row => String(row.ns) === NS)
    expect(descriptor?.value).toEqual({
      enabled: false,
      fallback: 'delegate',
      timeoutMs: 30_000,
      maxOutputTokens: 256,
      maxExcerptChars: 4000,
      instructions: '',
    })

    await expect(ctx.settings.update(ApprovalAdversary.APPROVAL_ADVERSARY_SETTINGS_NAMESPACE, { provider: 'reviewer' }))
      .rejects.toThrow('provider and model must be supplied together')
    await expect(ctx.settings.update(ApprovalAdversary.APPROVAL_ADVERSARY_SETTINGS_NAMESPACE, {
      instructions: 'x'.repeat(4097),
    })).rejects.toThrow('expected string length <= 4096')
    expect(provider.doc).toEqual({})
    await ctx.fiber.dispose()
  })

  it('arms the reviewer from a stored setting and a provider-published document', async () => {
    const { ctx, adapter, provider } = await settingsHarness({}, [ALLOW, DENY])
    const agent = sessionAgent('stored', { route: { provider: 'agent-route', model: 'm' } })

    await ctx.settings.update(ApprovalAdversary.APPROVAL_ADVERSARY_SETTINGS_NAMESPACE, { enabled: true })
    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('allowed-once')
    expect(adapter.requests).toHaveLength(1)

    provider.pushExternal({ [NS]: { enabled: false } })
    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('unavailable')
    expect(adapter.requests).toHaveLength(1)

    provider.pushExternal({ [NS]: { enabled: true, provider: 'reviewer', model: 'adversary' } })
    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('rejected')
    expect(adapter.requests[1]?.provider).toBe('reviewer')
    await ctx.fiber.dispose()
  })

  it('treats an empty stored route as absent and reviews on the agent route', async () => {
    const { ctx, adapter } = await settingsHarness({ enabled: true }, [ALLOW])
    const agent = sessionAgent('empty-route', { route: { provider: 'agent-route', model: 'm' } })

    await ctx.settings.update(ApprovalAdversary.APPROVAL_ADVERSARY_SETTINGS_NAMESPACE, { provider: '', model: '' })
    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('allowed-once')

    expect(adapter.requests[0]).toMatchObject({ provider: 'agent-route', model: 'm' })
    await ctx.fiber.dispose()
  })
})

describe('verdicts', () => {
  it('allows a justified step and tells the model why', async () => {
    const { ctx, adapter } = await harness(EXPLICIT, [ALLOW])
    const agent = sessionAgent('allow', {
      instruction: 'Rebuild the project after cleaning stale output.',
      call: { id: 'call-1', name: 'bash', arguments: '{"command":"rm -rf build && make"}' },
    })
    let downstream = 0
    ctx.on('approval/request', () => {
      downstream += 1
      return Promise.resolve<ApprovalOutcome>('rejected')
    })

    const outcome = await ctx.approval.request({
      agent, toolName: 'bash', callId: ToolCallId('call-1'), reason: 'clean stale output before rebuilding',
    })

    expect(outcome).toBe('allowed-once')
    expect(downstream).toBe(0)
    expect(adapter.requests).toHaveLength(1)
    expect(notices(agent.session.events)).toEqual([{
      summary: 'adversarial review: allowed',
      text: 'Adversarial approval review allowed "bash": the command rebuilds exactly what the user asked for',
    }])
  })

  it('denies and redirects the model to the user instruction', async () => {
    const { ctx } = await harness(EXPLICIT, [DENY])
    const agent = sessionAgent('deny', {
      instruction: 'Fix every failing test in the suite.',
      pluginMessage: 'Current runtime context. Approval policy: ask.',
    })
    let downstream = 0
    ctx.on('approval/request', () => {
      downstream += 1
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    const outcome = await ctx.approval.request({ agent, toolName: 'edit', reason: 'disable the failing tests' })

    expect(outcome).toBe('rejected')
    expect(downstream).toBe(0)
    expect(notices(agent.session.events)).toEqual([{
      summary: 'adversarial review: denied',
      text: 'Adversarial approval review denied "edit": disabling the suite hides failures instead of fixing them\n'
        + 'Do not resubmit the same request with a reworded justification. '
        + 'Return to the user\'s instructions and take the direct step they asked for.'
        + '\n\nUser instruction: Fix every failing test in the suite.',
    }])
  })

  it('quotes no instruction when the session holds only plugin messages', async () => {
    const { ctx } = await harness(EXPLICIT, [DENY])
    const agent = sessionAgent('deny-plugin-only', { pluginMessage: 'Delegated task body.' })

    await expect(ctx.approval.request({ agent, toolName: 'edit', reason: 'disable the failing tests' }))
      .resolves.toBe('rejected')

    const [notice] = notices(agent.session.events)
    expect(notice?.text).not.toContain('User instruction:')
  })

  it('parses the verdict case-insensitively and reports a missing reason', async () => {
    const { ctx } = await harness(EXPLICIT, [reply('verdict: allow')])
    const agent = sessionAgent('lenient')

    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('allowed-once')

    expect(notices(agent.session.events)[0]?.text)
      .toBe('Adversarial approval review allowed "bash": no reason given')
  })
})

describe('review request', () => {
  it('logs the exact request before dispatch and sends the same request to the reviewer', async () => {
    const { ctx, adapter } = await harness(EXPLICIT, [ALLOW])
    const agent = sessionAgent('logged', {
      instruction: 'Rebuild the project.',
      call: { id: 'call-7', name: 'bash', arguments: '{"command":"make"}' },
    })

    await ctx.approval.request({ agent, toolName: 'bash', callId: ToolCallId('call-7'), reason: 'run the build' })

    const events = agent.session.events
    const asked = events.find(event => event.type === 'approval/asked')!
    const review = loggedReview(events)
    expect(review).toMatchObject({
      approvalId: asked.data.id,
      toolName: 'bash',
      route: { provider: 'reviewer', model: 'adversary' },
      system: ApprovalAdversary.REVIEW_INSTRUCTIONS,
      maxTokens: 256,
    })
    expect(events.indexOf(events.find(event => event.type === 'approval/adversary-request')!))
      .toBeGreaterThan(events.indexOf(asked))

    const request = adapter.requests[0]!
    expect(request).toMatchObject({
      provider: 'reviewer',
      model: 'adversary',
      system: review.system,
      maxTokens: 256,
      sessionId: agent.session.id,
    })
    expect(request.messages).toEqual(review.messages)
    expect(request.tools).toBeUndefined()
    expect(reviewedRecord(request)).toEqual({
      instruction: 'Rebuild the project.',
      tool: 'bash',
      call: { name: 'bash', arguments: '{"command":"make"}' },
      justification: 'run the build',
    })
  })

  it('frames a missing call, a blank justification, and an unlogged call as null', async () => {
    const { ctx, adapter } = await harness(EXPLICIT, [ALLOW, ALLOW])
    const agent = sessionAgent('nulls')

    await ctx.approval.request({ agent, toolName: 'read', reason: '   ' })
    await ctx.approval.request({ agent, toolName: 'read', callId: ToolCallId('unlogged') })

    expect(reviewedRecord(adapter.requests[0]!)).toEqual({ instruction: null, tool: 'read', call: null, justification: null })
    expect(reviewedRecord(adapter.requests[1]!)).toEqual({ instruction: null, tool: 'read', call: null, justification: null })
    const asks = agent.session.events.filter(event => event.type === 'approval/asked')
    expect(loggedReviews(agent.session.events).map(event => event.data.approvalId))
      .toEqual(asks.map(event => event.data.id))
  })

  it('pairs each review with its own audit record while two questions are open at once', async () => {
    const { ctx } = await harness(EXPLICIT, [ALLOW, ALLOW])
    const agent = sessionAgent('parallel')

    // Both asks are logged before either review dispatches, so the newest
    // audit record is the other question's for one of them.
    const outcomes = await Promise.all([
      ctx.approval.request({ agent, toolName: 'read', callId: ToolCallId('call-a'), reason: 'first' }),
      ctx.approval.request({ agent, toolName: 'read', callId: ToolCallId('call-b'), reason: 'second' }),
    ])

    expect(outcomes).toEqual(['allowed-once', 'allowed-once'])
    const asks = agent.session.events.filter(event => event.type === 'approval/asked')
    expect(asks.map(event => event.data.callId)).toEqual(['call-a', 'call-b'])
    expect(loggedReviews(agent.session.events).map(event => event.data.approvalId))
      .toEqual(asks.map(event => event.data.id))
  })

  it('quotes the latest human message that carries text', async () => {
    const { ctx, adapter } = await harness(EXPLICIT, [ALLOW])
    const agent = sessionAgent('text-less', { instruction: 'Rebuild the project.' })
    agent.session.append('user/message', createUserMessage({ content: [], source: { kind: 'user' } }), { surfaceOp: 'append' })

    await ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })

    expect(reviewedRecord(adapter.requests[0]!).instruction).toBe('Rebuild the project.')
  })

  it('reads the verdict from text blocks and ignores reasoning', async () => {
    const { ctx } = await harness(EXPLICIT, [[
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'weighing the record' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'weighing the record' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'VERDICT: DENY\nREASON: out of scope' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'VERDICT: DENY\nREASON: out of scope' } },
      { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]])
    const agent = sessionAgent('reasoned')

    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('rejected')

    expect(notices(agent.session.events)[0]?.text).toContain('denied "bash": out of scope')
  })

  it('records no approval id when dispatched outside the service', async () => {
    const { ctx } = await harness(EXPLICIT, [ALLOW])
    const agent = sessionAgent('direct')

    const outcome = await ctx.waterfall(
      scopeTarget(agent, agent), 'approval/request', { agent, toolName: 'bash' },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )

    expect(outcome).toBe('allowed-once')
    expect(loggedReview(agent.session.events)).not.toHaveProperty('approvalId')
  })

  it('clips every excerpt to maxExcerptChars and marks the cut', async () => {
    const { ctx, adapter } = await harness({ ...EXPLICIT, maxExcerptChars: 8 }, [DENY])
    const agent = sessionAgent('clipped', {
      instruction: 'Rebuild everything now.',
      call: { id: 'call-1', name: 'bash', arguments: '{"command":"make all"}' },
    })

    await ctx.approval.request({ agent, toolName: 'bash', callId: ToolCallId('call-1'), reason: 'a long justification' })

    expect(reviewedRecord(adapter.requests[0]!)).toEqual({
      instruction: 'Rebuild …[truncated]',
      tool: 'bash',
      call: { name: 'bash', arguments: '{"comman…[truncated]' },
      justification: 'a long j…[truncated]',
    })
    expect(notices(agent.session.events)[0]?.text).toContain('User instruction: Rebuild …[truncated]')
  })

  it('appends deployment instructions after the fixed review instruction', async () => {
    const instructions = 'Deny anything that touches the production database.'
    const { ctx, adapter } = await harness({ ...EXPLICIT, instructions }, [ALLOW])
    const agent = sessionAgent('instructed')

    await ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })

    expect(adapter.requests[0]?.system).toBe(`${ApprovalAdversary.REVIEW_INSTRUCTIONS}\n\n${instructions}`)
    expect(loggedReview(agent.session.events).system).toBe(adapter.requests[0]?.system)
  })

  it('reviews on the agent\'s own latest route when none is configured', async () => {
    const { ctx, adapter } = await harness({ enabled: true }, [ALLOW])
    const agent = sessionAgent('own-route', { route: { provider: 'agent-route', model: 'm' } })

    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('allowed-once')

    expect(adapter.requests[0]).toMatchObject({ provider: 'agent-route', model: 'm' })
    expect(loggedReview(agent.session.events).route).toEqual({ provider: 'agent-route', model: 'm' })
  })
})

describe('undecided reviews', () => {
  /** Boot the reviewer with `fallback: reject` over one scripted entry and decide one request. */
  async function undecided(entry: ScriptEntry, overrides: { timeoutMs?: number } = {}) {
    const { ctx, adapter } = await harness({ ...EXPLICIT, fallback: 'reject', ...overrides }, [entry])
    const agent = sessionAgent('undecided', { route: { provider: 'agent-route', model: 'm' } })
    const outcome = await ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })
    return { outcome, adapter, notice: notices(agent.session.events)[0] }
  }

  it('delegates when no route can be resolved', async () => {
    const { ctx, adapter } = await harness({ enabled: true }, [ALLOW])
    const agent = sessionAgent('no-route')
    let downstream = 0
    ctx.on('approval/request', () => {
      downstream += 1
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('allowed-once')

    expect(downstream).toBe(1)
    expect(adapter.requests).toEqual([])
    expect(agent.session.events.some(event => event.type === 'approval/adversary-request')).toBe(false)
    expect(notices(agent.session.events)).toEqual([])
  })

  it('rejects with an unavailable notice when no route can be resolved and the fallback rejects', async () => {
    const { ctx } = await harness({ enabled: true, fallback: 'reject' }, [])
    const agent = sessionAgent('no-route-reject')

    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('rejected')

    expect(notices(agent.session.events)).toEqual([{
      summary: 'adversarial review: unavailable',
      text: 'Adversarial approval review could not decide "bash" (no model route: configure provider and model '
        + 'together, or review after the agent\'s first request) and this deployment rejects undecided requests. '
        + 'Continue with a step the user asked for that needs no approval.',
    }])
  })

  it('delegates a reply without a verdict line to the next answerer', async () => {
    const { ctx } = await harness(EXPLICIT, [reply('I cannot tell from this record.')])
    const agent = sessionAgent('no-verdict')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    await expect(ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild' })).resolves.toBe('allowed-once')

    expect(notices(agent.session.events)).toEqual([])
  })

  it('treats a verdict-less reply, an output cut, a tool call, and an error finish as undecided', async () => {
    const cases: [ScriptEntry, string][] = [
      [reply('I cannot tell.'), 'review model produced no VERDICT line'],
      [reply('VERDICT: AL', { type: 'finish', reason: { kind: 'max-tokens' } }), 'verdict output reached maxOutputTokens'],
      [reply('VERDICT: ALLOW', { type: 'finish', reason: { kind: 'tool-calls' } }), 'review model unexpectedly requested a tool'],
      [reply('', { type: 'finish', reason: { kind: 'error', failure: { code: 'REVIEW_FIXTURE', message: 'boom' } } }), 'boom'],
      [reply('', { type: 'finish', reason: { kind: 'weird' } as never }), 'unsupported finish reason "weird"'],
    ]
    for (const [entry, failure] of cases) {
      const { outcome, notice } = await undecided(entry)
      expect(outcome).toBe('rejected')
      expect(notice?.summary).toBe('adversarial review: unavailable')
      expect(notice?.text).toContain(`could not decide "bash" (${failure})`)
    }
  })

  it('treats a review that outlives timeoutMs as undecided', async () => {
    const { outcome, notice } = await undecided('hang', { timeoutMs: 20 })

    expect(outcome).toBe('rejected')
    expect(notice?.summary).toBe('adversarial review: unavailable')
  })

  it('resolves cancelled without a notice when the question is withdrawn during the review', async () => {
    const controller = new AbortController()
    const { ctx } = await harness({ ...EXPLICIT, fallback: 'reject' }, [
      async function * (options) {
        yield { type: 'block-start', index: 0, blockType: 'text' }
        controller.abort()
        yield { type: 'text-delta', index: 0, text: 'VERDICT: ALLOW' }
        // The runtime stops a cancelled stream; a cooperative adapter also stops itself.
        options.signal?.throwIfAborted()
      },
    ])
    const agent = sessionAgent('withdrawn')

    const outcome = await ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild', signal: controller.signal })

    expect(outcome).toBe('cancelled')
    expect(notices(agent.session.events)).toEqual([])
  })

  it('resolves cancelled when the question is withdrawn as the review completes', async () => {
    const controller = new AbortController()
    const { ctx } = await harness({ ...EXPLICIT, fallback: 'reject' }, [
      async function * () {
        for (const chunk of ALLOW) yield chunk
        controller.abort()
      },
    ])
    const agent = sessionAgent('withdrawn-late')

    const outcome = await ctx.approval.request({ agent, toolName: 'bash', reason: 'rebuild', signal: controller.signal })

    expect(outcome).toBe('cancelled')
    expect(notices(agent.session.events)).toEqual([])
  })

  it('resolves cancelled when dispatched with a signal that is already aborted', async () => {
    const { ctx, adapter } = await harness({ ...EXPLICIT, fallback: 'reject' }, [ALLOW])
    const agent = sessionAgent('pre-aborted')

    const outcome = await ctx.waterfall(
      scopeTarget(agent, agent), 'approval/request',
      { agent, toolName: 'bash', signal: AbortSignal.abort() },
      () => Promise.resolve<ApprovalOutcome>('unavailable'),
    )

    expect(outcome).toBe('cancelled')
    expect(adapter.requests).toEqual([])
    expect(notices(agent.session.events)).toEqual([])
  })
})
