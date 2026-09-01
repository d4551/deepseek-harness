import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import LlmRuntime, { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  Message,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput, SummaryResult } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'
import { MODEL, agent, conversation, promptInput } from './harness.ts'

/** A model service streaming one fixed block sequence per call. */
class ScriptedStreamService extends LlmAdapter {
  lastOptions: GenerateOptions | undefined
  usage: TokenUsage | undefined

  constructor(
    private readonly blocks: readonly ContentBlock[],
    private readonly finish: (StreamChunk & { type: 'finish' })['reason'] = { kind: 'stop' },
  ) {
    super()
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.lastOptions = options
    for (const [index, block] of this.blocks.entries()) {
      yield { type: 'block-start', index, blockType: block.type }
      if (block.type === 'text') {
        yield { type: 'text-delta', index, text: block.text }
      } else if (block.type === 'reasoning') {
        yield { type: 'reasoning-delta', index, text: block.text }
      } else {
        yield { type: 'block-end', index, block }
      }
    }
    if (this.usage !== undefined) yield { type: 'usage', usage: this.usage }
    yield { type: 'finish', reason: this.finish }
  }
}

/** An engine exposing its summarize hook for direct one-shot tests. */
class ExposedCompactionEngine extends BasicCompactionEngine {
  runSummarize(
    input: SummarizationInput,
    owner: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    return this.summarize(input, owner, signal)
  }
}

async function summarizerHarness(
  blocks: readonly ContentBlock[],
  finish?: (StreamChunk & { type: 'finish' })['reason'],
  model = MODEL,
  config: BasicCompactionConfig = { auto: false },
): Promise<{ ctx: Context; scripted: ScriptedStreamService; compact: ExposedCompactionEngine }> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  const scripted = new ScriptedStreamService(blocks, finish)
  ctx.llm.registerAdapter([model], scripted)
  const compact = new ExposedCompactionEngine(ctx, config)
  return { ctx, scripted, compact }
}

describe('default one-shot summarizer', () => {
  it('requires complete raw output when a subclass marks one local LLM stream call', () => {
    expectTypeOf<{
      summary: ContentBlock[]
      llmStreamCall: true
      provider: string
      model: string
    }>().not.toExtend<SummaryResult>()
  })

  it('uses configured model/default cap, forwards cancellation, and keeps only safe text', async () => {
    const { scripted, compact } = await summarizerHarness([
      { type: 'reasoning', text: 'private' },
      { type: 'text', text: 'public summary' },
      { type: 'tool-call', id: ToolCallId('unexpected'), name: 'x', arguments: '{}' },
    ], undefined, MODEL, {
      auto: false,
      summarizationProvider: MODEL,
      summarizationModel: MODEL,
      maxTokens: 321,
    })
    const session = conversation(1)
    scripted.usage = { inputTokens: 12, outputTokens: 3 }
    const signal = new AbortController().signal
    const output = await compact.runSummarize(promptInput('transcript'), agent(session, 'agent-option'), signal)

    expect(output).toEqual({
      summary: [{ type: 'text', text: 'public summary' }],
      rawOutput: [
        { type: 'reasoning', text: 'private' },
        { type: 'text', text: 'public summary' },
        { type: 'tool-call', id: ToolCallId('unexpected'), name: 'x', arguments: '{}' },
      ],
      llmStreamCall: true,
      provider: MODEL,
      model: MODEL,
      maxTokens: 321,
      usage: scripted.usage,
    })
    expect(scripted.lastOptions).toMatchObject({
      provider: MODEL,
      model: MODEL,
      maxTokens: 321,
      signal,
      sessionId: session.id,
      purpose: 'compaction',
    })
    const instruction = scripted.lastOptions?.messages.at(-1)?.content[0]
    expect(instruction?.type === 'text' ? instruction.text : '').toContain('## Primary Request and Intent')
  })

  it('replays the conversation prefix and appends the instruction as the final message', async () => {
    const { scripted, compact } = await summarizerHarness([{ type: 'text', text: 'summary' }])
    const tools = [{ name: 'do_thing', description: 'd', parameters: { type: 'object' } }]
    const prefix: Message = createUserMessage({
      content: [
        { type: 'text', text: 'earlier turn' },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
            mediaType: 'image/png',
            bytes: 1,
            width: 1,
            height: 1,
          },
        },
      ],
      source: { kind: 'plugin', plugin: 'test' },
    })
    await compact.runSummarize({
      system: 'REPLAYED SYSTEM',
      tools,
      messages: [prefix],
    }, agent(conversation(1), MODEL))

    expect(scripted.lastOptions?.system).toBe('REPLAYED SYSTEM')
    expect(scripted.lastOptions?.tools).toEqual(tools)
    const messages = scripted.lastOptions?.messages ?? []
    expect(messages[0]).toEqual(prefix)
    const last = messages.at(-1)?.content[0]
    const lastText = last?.type === 'text' ? last.text : ''
    expect(lastText).toContain('Write concise English engineering prose.')
    expect(lastText).toContain('numeric values, function signatures, and syntax fragments.')
    expect(lastText).toContain('## Primary Request and Intent')
  })

  it('applies the routed model policy without changing the replayed prefix', async () => {
    const { ctx, compact } = await summarizerHarness(
      [{ type: 'text', text: 'unused default summary' }],
      undefined,
      MODEL,
      {
        auto: false,
        maxTokens: 111,
        modelPolicies: [{
          provider: MODEL,
          model: MODEL,
          summarizationProvider: 'policy-summary',
          summarizationModel: 'policy-summary',
          maxTokens: 222,
        }],
      },
    )
    const policyService = new ScriptedStreamService([{ type: 'text', text: 'policy summary' }])
    ctx.llm.registerAdapter(['policy-summary'], policyService)
    const prefix: Message = createUserMessage({
      content: [{ type: 'text', text: 'warm prefix' }],
      source: { kind: 'plugin', plugin: 'test' },
    })

    const output = await compact.runSummarize({
      system: 'WARM SYSTEM',
      messages: [prefix],
    }, agent(conversation(1), 'agent-option'))

    expect(output).toMatchObject({
      provider: 'policy-summary',
      model: 'policy-summary',
      maxTokens: 222,
    })
    expect(policyService.lastOptions).toMatchObject({
      provider: 'policy-summary',
      model: 'policy-summary',
      maxTokens: 222,
      system: 'WARM SYSTEM',
    })
    expect(policyService.lastOptions?.messages[0]).toEqual(prefix)
  })

  it('resolves the latest routed provider/model before the AgentOptions pair', async () => {
    const { scripted, compact } = await summarizerHarness([{ type: 'text', text: 'summary' }], undefined, 'routed')
    const session = conversation(1)
    session.append('request/header', {
      header: { config: { provider: 'routed', model: 'routed' } },
      reason: 'initial',
    })
    const output = await compact.runSummarize(promptInput('history'), agent(session, 'agent-option'))
    expect(output.provider).toBe('routed')
    expect(output.model).toBe('routed')
    expect(scripted.lastOptions?.provider).toBe('routed')
    expect(scripted.lastOptions?.model).toBe('routed')
  })

  it('records the model actually dispatched after one-shot stream routing', async () => {
    const { ctx, compact } = await summarizerHarness([{ type: 'text', text: 'unused' }])
    const routedService = new ScriptedStreamService([{ type: 'text', text: 'routed summary' }])
    ctx.llm.registerAdapter(['routed-summary-provider'], routedService)
    ctx.on('llm/stream', (options, next) => {
      options.provider = 'routed-summary-provider'
      options.model = 'routed-summary-model'
      return next()
    })

    const session = conversation(3, 'large history '.repeat(500))
    const nodes = session.surface.nodes
    const first = nodes[0]
    const fourth = nodes[3]
    if (first === undefined || fourth === undefined) throw new Error('fixture surface too small')
    await compact.compactRegion(first, fourth, agent(session, MODEL), new AbortController().signal)
    expect(session.events.findLast(event => event.type === 'compaction/summary')?.data).toMatchObject({
      summary: [{ type: 'text', text: 'routed summary' }],
      llmStreamCall: true,
      provider: 'routed-summary-provider',
      model: 'routed-summary-model',
    })
    expect(routedService.lastOptions?.provider).toBe('routed-summary-provider')
    expect(routedService.lastOptions?.model).toBe('routed-summary-model')
  })

  it('fails clearly when no complete summarization target can be resolved', async () => {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(TokenMeter)
    const compact = new ExposedCompactionEngine(ctx, { auto: false })
    await expect(compact.runSummarize(promptInput('history'), agent(Session.create(SessionId('model-less')))))
      .rejects.toThrow(/no provider\/model available for summarization/)
  })

  it('uses a complete AgentOptions target when no durable route exists', async () => {
    const { scripted, compact } = await summarizerHarness([{ type: 'text', text: 'summary' }])
    const session = Session.create(SessionId('headerless-summary'))

    await expect(compact.runSummarize(promptInput('history'), agent(session, MODEL))).resolves.toMatchObject({
      provider: MODEL,
      model: MODEL,
    })
    expect(scripted.lastOptions).toMatchObject({ provider: MODEL, model: MODEL })
  })

  it.each([
    { provider: '', model: MODEL },
    { provider: MODEL },
    { provider: MODEL, model: '' },
  ])('rejects incomplete AgentOptions target %#', async (options) => {
    const { compact } = await summarizerHarness([{ type: 'text', text: 'unused' }])
    const owner = {
      session: Session.create(SessionId(`incomplete-${String(options.model)}`)),
      options,
    } as Agent
    await expect(compact.runSummarize(promptInput('history'), owner))
      .rejects.toThrow(/no provider\/model available for summarization/)
  })

  it.each([
    [{ kind: 'error', failure: { message: 'provider failed', code: 'PROVIDER' } }, 'PROVIDER', /provider failed/],
    [{ kind: 'error', failure: { message: 'opaque', code: 'UNKNOWN' } }, 'UNKNOWN', /opaque/],
    [{ kind: 'aborted', failure: { message: 'summarization aborted', code: 'ABORTED' } }, 'ABORTED', /aborted/],
    [{ kind: 'max-tokens' }, 'MAX_TOKENS', /token cap/],
  ] as Array<[(StreamChunk & { type: 'finish' })['reason'], string | undefined, RegExp]>)(
    'rejects terminal finish %#',
    async (finish, code, pattern) => {
      const { compact } = await summarizerHarness([], finish)
      const thrown = await compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL))
        .then(() => null, (error: unknown) => error)
      expect(thrown).toBeInstanceOf(Error)
      expect(thrown).toMatchObject({ code })
      if (thrown instanceof Error) expect(thrown.message).toMatch(pattern)
    },
  )

  it('rejects empty or reasoning-only successful output', async () => {
    const { compact } = await summarizerHarness([{ type: 'reasoning', text: 'private' }])
    await expect(compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL)))
      .rejects.toThrow(/no text summary content/)
  })

  it('rejects image summary output instead of silently dropping it', async () => {
    const { compact } = await summarizerHarness([
      {
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      },
      { type: 'text', text: 'partial summary' },
    ])
    await expect(compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })

  it('rejects image summary output nested in a tool result', async () => {
    const { compact } = await summarizerHarness([{
      type: 'tool-result',
      toolCallId: ToolCallId('summary-tool'),
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'c'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 1,
          width: 1,
          height: 1,
        },
      }],
    }])
    await expect(compact.runSummarize(promptInput('history'), agent(conversation(1), MODEL)))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
  })
})
