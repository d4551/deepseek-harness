import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeContext, ConversationNodeDefinition,
  ConversationPromptSnapshotReader, RequestPromptInspector,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Complete system prompt rendered for one model request. */
    'system-prompt': { readonly text: string }
  }
}

interface RequestPromptState extends ReturnType<RequestPromptInspector> {
  readonly anchorSeq: number
  readonly showsPrompt: boolean
  readonly turn?: number
  readonly step?: number
}

function isRecord(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function previousRequestPrompt(
  value: unknown,
  readPrompt: ConversationPromptSnapshotReader,
): RequestPromptState | undefined {
  if (value === undefined) return undefined
  if (!isRecord(value)) throw new TypeError('request-prompt predecessor State is not an object')
  const prompt = readPrompt(Reflect.get(value, 'prompt'))
  const anchorSeq: unknown = Reflect.get(value, 'anchorSeq')
  const showsPrompt: unknown = Reflect.get(value, 'showsPrompt')
  if (typeof anchorSeq !== 'number' || !Number.isSafeInteger(anchorSeq)
    || typeof showsPrompt !== 'boolean') {
    throw new TypeError('request-prompt predecessor State is malformed')
  }
  const turn: unknown = Reflect.get(value, 'turn')
  const step: unknown = Reflect.get(value, 'step')
  return {
    prompt,
    anchorSeq,
    showsPrompt,
    ...typeof turn === 'number' && Number.isSafeInteger(turn) && turn >= 0 ? { turn } : {},
    ...typeof step === 'number' && Number.isSafeInteger(step) && step >= 0 ? { step } : {},
  }
}

/** Place a request's system field at the start of its visible message series. */
function requestPromptAnchor(
  match: ConversationMatch,
  previous: Readonly<RequestPromptState> | undefined,
  isInitial: boolean,
): number {
  if (match.location.kind !== 'step') return match.event.seq
  if (previous === undefined && !isInitial) return match.event.seq
  if (previous?.turn === match.location.turn.turn
    && previous.step === match.location.step.step) return match.event.seq
  return match.location.step.step === 1
    ? match.location.turn.start?.seq ?? match.location.step.start?.seq ?? match.event.seq
    : match.location.step.start?.seq ?? match.event.seq
}

/** Keep an already rendered prompt at its page-lifetime presentation anchor. */
function stableRequestPromptAnchor(
  context: ConversationNodeContext<RequestPromptState>,
  match: ConversationMatch,
  previous: Readonly<RequestPromptState> | undefined,
  isInitial: boolean,
): number {
  const current = context.current.get('chat')
  if (current !== undefined && current !== null && current.kind === 'system-prompt') {
    const anchorSeq: unknown = Reflect.get(current, 'anchorSeq')
    if (typeof anchorSeq === 'number' && Number.isSafeInteger(anchorSeq)) return anchorSeq
  }
  return requestPromptAnchor(match, previous, isInitial)
}

/**
 * Request-header prompt Definition for the Chat target.
 * @param inspect - request-header prompt interpretation.
 * @param readPrompt - claim a stored prompt snapshot.
 * @returns the Chat request-prompt Definition.
 */
export function requestPromptDefinition(
  inspect: RequestPromptInspector,
  readPrompt: ConversationPromptSnapshotReader,
): ConversationNodeDefinition<RequestPromptState> {
  return {
    kind: 'request-prompt',
    target: 'chat',
    match: event => event.type === 'request/header'
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (context, match, reader) => {
      if (match.event.type !== 'request/header') {
        throw new Error('request-prompt start requires request/header')
      }
      const previous = previousRequestPrompt(reader.previous('request-prompt')?.state, readPrompt)
      const location = match.location.kind === 'step'
        ? { turn: match.location.turn.turn, step: match.location.step.step }
        : {}
      const inspection = inspect(previous?.prompt, match.event)
      const change = inspection.change?.kind
      return {
        anchorSeq: stableRequestPromptAnchor(
          context,
          match,
          previous,
          match.event.data.reason === 'initial',
        ),
        showsPrompt: previous === undefined
          || match.event.data.reason !== 'change'
          || match.event.data.startsSeries === true
          || change === 'system'
          || change === 'system-and-tools',
        ...location,
        ...inspection,
      }
    },
    update: context => context.state,
    buildViewNode: (context) => {
      const state = context.state
      if (state === undefined || !state.showsPrompt || state.prompt.system === '') return null
      return chatNode(context, 'system-prompt', state.anchorSeq, { text: state.prompt.system })
    },
  }
}

/**
 * Register model-request system prompts in the Chat flow.
 * @param ctx - Owning UI Conversation context.
 */
export function registerRequestPromptConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(requestPromptDefinition(
    (previous, event) => ctx.uiConversation.inspectRequestPrompt(previous, event),
    value => ctx.uiConversation.requireConversationPromptSnapshot(value),
  ))
}
