/**
 * Shared fixtures and stubs for the compaction-basic test specs.
 */

import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, {
  CONTEXT_WINDOW_EXCEEDED_CODE,
  createMessage,
  createToolResultMessage,
  createUserMessage,
  LlmAdapter,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  LlmFailure,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { agentEvents, type Agent, type RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { SummarizationInput } from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

export const MODEL = 'test-model'

/** A model service reporting one fixed context window; streams an empty finish. */
class ContextModelService extends LlmAdapter {
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

/** A model service reporting per-provider context windows. */
export class RoutedContextModelService extends LlmAdapter {
  constructor(private readonly windows: Readonly<Record<string, number>>) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const contextWindow = this.windows[provider]
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      ...contextWindow === undefined ? {} : { context: { contextWindow } },
    })
  }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A context with LLM and token-meter services registered. */
export async function createContext(contextWindow = 1_000): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(
    [MODEL, 'actual', 'unlisted-provider'],
    new ContextModelService(contextWindow),
  )
  return ctx
}

export function agent(session: Session, model?: string): Agent {
  return {
    session,
    options: model === undefined ? {} : { provider: model, model },
  } as Agent
}

/** Flatten every text fragment the summarizer received, recursing tool-result blocks. */
export function summarizedText(input: SummarizationInput): string {
  const collect = (blocks: readonly ContentBlock[]): string =>
    blocks.map(block =>
      block.type === 'text' ? block.text
        : block.type === 'tool-result' ? collect(block.content)
          : '').join('\n')
  return input.messages.map(message => collect(message.content)).join('\n')
}

/** A minimal replayed prefix carrying one user message of the given text. */
export function promptInput(text: string): SummarizationInput {
  return { messages: [createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })] }
}

/** Append one routed request header marking the initial model route. */
function appendInitialHeader(session: Session): void {
  session.append('request/header', {
    header: { config: { provider: MODEL, model: MODEL } },
    reason: 'initial',
  })
}

/** Append one step boundary with the given turn number. */
function appendStepStart(session: Session, turn: number): void {
  session.append('step/start', { turn, step: 1 })
}

/** Append one surface user message carrying the given text. */
function appendUserText(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Closed two-message turns followed by one open turn for durable compaction events. */
export function conversation(turns = 4, text = 'fixture '.repeat(40).trim()): Session {
  const session = Session.create(SessionId(`conversation-${turns}`))
  for (let turn = 1; turn <= turns; turn += 1) {
    session.append('turn/start', { turn })
    appendUserText(session, `${text} user ${turn}`)
    appendStepStart(session, turn)
    if (turn === 1) appendInitialHeader(session)
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `${text} assistant ${turn}` }],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', {
    turn: turns + 1,
  })
  return session
}

/** Closed tool-calling turns followed by an open turn. */
export function toolConversation(): Session {
  const session = Session.create(SessionId('tools'))
  for (let turn = 1; turn <= 3; turn += 1) {
    const callId = ToolCallId(`call-${turn}`)
    session.append('turn/start', { turn })
    appendUserText(session, `request ${turn} `.repeat(300))
    appendStepStart(session, turn)
    if (turn === 1) appendInitialHeader(session)
    session.append('assistant/message', {
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [
          { type: 'text', text: `calling ${turn} `.repeat(300) },
          { type: 'tool-call', id: callId, name: 'read', arguments: '{}' },
        ],
        source: {
          kind: 'model',
          ...{ provider: MODEL, model: MODEL },
        },
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn, step: 1, callId, name: 'read', arguments: '{}' })
    session.append('tool/result', {
      turn,
      step: 1,
      message: createToolResultMessage({
        callId,
        content: [{ type: 'text', text: `result ${turn} `.repeat(300) }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: 4 })
  return session
}

/** One closed routed tool step followed by an open turn for rewrite events. */
export function oversizedToolResult(chars = 3_000, withCompactablePrompt = false): Session {
  const session = Session.create(SessionId(`oversized-tool-${chars}`))
  const callId = ToolCallId('oversized')
  session.append('turn/start', { turn: 1 })
  if (withCompactablePrompt) {
    appendUserText(session, 'older history '.repeat(200))
  }
  appendStepStart(session, 1)
  appendInitialHeader(session)
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name: 'bash', arguments: '{}' }],
      source: {
        kind: 'model',
        ...{ provider: MODEL, model: MODEL },
      },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: '{}' })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({
      callId,
      content: [{ type: 'text', text: 'X'.repeat(chars) }],
      isError: false,
    }),
    meta: { presentation: 'preserved' },
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  session.append('turn/start', { turn: 2 })
  return session
}

/** An engine whose summarize hook returns fixed scripted blocks. */
export class TestCompactionEngine extends BasicCompactionEngine {
  summary: ContentBlock[] = [{ type: 'text', text: 'small checkpoint' }]
  rawOutput: ContentBlock[] | undefined
  usage: TokenUsage | undefined
  summaryProvider = 'summary-provider'
  summaryModel = 'summary-model'
  error: Error | string | number | undefined
  mutateDuringSummary: (() => void) | undefined
  calls: Array<{ input: SummarizationInput; signal: AbortSignal | undefined }> = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    signal?: AbortSignal,
  ): Promise<{
    summary: ContentBlock[]
    rawOutput?: ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
    usage?: TokenUsage
  }> {
    this.calls.push({ input, signal })
    this.mutateDuringSummary?.()
    if (this.error !== undefined) throw this.error
    return {
      summary: this.summary,
      ...this.rawOutput === undefined ? {} : { rawOutput: this.rawOutput },
      provider: this.summaryProvider,
      model: this.summaryModel,
      maxTokens: 123,
      ...this.usage === undefined ? {} : { usage: this.usage },
    }
  }
}

/** Build a scripted test engine on the given or a fresh context. */
export async function service(
  config: BasicCompactionConfig = { auto: false },
  ctx?: Context,
): Promise<TestCompactionEngine> {
  return new TestCompactionEngine(ctx ?? await createContext(), config)
}

/** Run one compactIfNeeded pass with the default model route. */
export async function compactIfNeeded(
  compact: BasicCompactionEngine,
  session: Session,
  trigger: 'pressure' | 'context-overflow' = 'pressure',
  model: string | undefined = MODEL,
): Promise<CompactionResult | null> {
  return compact.compactIfNeeded(agent(session, model), trigger, new AbortController().signal)
}

/** Run the agent/pre-step waterfall with the given owner. */
export function preStep(
  ctx: Context,
  owner: Agent,
  signal: AbortSignal = new AbortController().signal,
) {
  return agentEvents(ctx, owner).waterfall(
    'agent/pre-step', { messages: [], turn: 1, step: 1, signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

/** Run the agent/request-error waterfall and report whether it requested a retry. */
export function recover(
  ctx: Context,
  owner: Agent,
  error: Error & { code?: string },
  signal: AbortSignal = new AbortController().signal,
  next: () => Promise<RequestErrorAction> = () => Promise.resolve(undefined),
): Promise<boolean> {
  const failure: LlmFailure = { message: error.message, code: error.code ?? 'UNKNOWN' }
  const turn = owner.session.events.findLast(event => event.type === 'turn/start')?.data.turn ?? 1
  return agentEvents(ctx, owner).waterfall(
    'agent/request-error',
    { turn, step: 1, provider: 'test', failure, retryPolicy: undefined, signal },
    next,
  ).then(action => action?.kind === 'retry')
}

/** A context-overflow error with the canonical provider code. */
export function overflow(message = 'provider overflow'): Error & { code: string } {
  return Object.assign(new Error(message), { code: CONTEXT_WINDOW_EXCEEDED_CODE })
}
