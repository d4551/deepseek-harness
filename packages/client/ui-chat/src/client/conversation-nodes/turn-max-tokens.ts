import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationMatch, ConversationNodeDefinition,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
// The declaring package, not the local barrel: a Typert-modeled reference must
// name the package that owns the type so the generated import can point at it.
import type { TurnMaxTokensNode } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode, turnNoticePosition } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    /** Turn ended by the per-request output-token cap. */
    'turn-max-tokens': TurnMaxTokensNode
  }
}

interface TurnMaxTokensState {
  readonly turn: number
  readonly seq: number
  readonly time: number
}

function stateFrom(match: ConversationMatch): TurnMaxTokensState | undefined {
  if (match.event.type !== 'turn/end' || match.event.data.reason.kind !== 'max-tokens') return undefined
  return { turn: match.event.data.turn, seq: match.event.seq, time: match.event.time }
}

/** Notice Definition for a turn the provider ended at its output-token cap. */
export const turnMaxTokensDefinition: ConversationNodeDefinition<TurnMaxTokensState> = {
  kind: 'turn-max-tokens',
  target: 'chat',
  match: (event) => {
    if (event.type === 'turn/end' && event.data.reason.kind === 'max-tokens') {
      return { id: String(event.data.turn), role: 'start' }
    }
    return null
  },
  start: (_context, match) => {
    const state = stateFrom(match)
    if (state === undefined) throw new Error('turn-max-tokens start requires a max-tokens turn/end')
    return state
  },
  update: context => context.state,
  buildViewNode: (context) => {
    const state = context.state
    if (state === undefined) return null
    const position = turnNoticePosition(context, state.seq)
    const node: TurnMaxTokensNode = {
      kind: 'turn-max-tokens',
      seq: state.seq,
      time: state.time,
      turn: state.turn,
      step: position.step,
    }
    return chatNode(context, 'turn-max-tokens', position.anchor, node)
  },
}

/**
 * Register the max-tokens turn-end notice contribution.
 * @param ctx - owning UI Conversation context.
 */
export function registerTurnMaxTokensConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnMaxTokensDefinition)
}
