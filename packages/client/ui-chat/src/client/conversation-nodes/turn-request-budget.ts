import type { Context } from '@deepseek-ai/cordis'
import type {
  ConversationNodeDefinition, TurnRequestBudgetNode,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { chatNode, turnNoticePosition } from './common.ts'

declare module '../contract/chat-nodes.ts' {
  interface ChatNodeDataMap {
    'turn-request-budget': TurnRequestBudgetNode
  }
}

/** Project the actual host budget pause from both live and restored turn history. */
export const turnRequestBudgetDefinition: ConversationNodeDefinition<TurnRequestBudgetNode> = {
  kind: 'turn-request-budget',
  target: 'chat',
  match: event => event.type === 'turn/end' && event.data.reason.kind === 'request-budget'
    ? { id: String(event.data.turn), role: 'start' }
    : null,
  start: (_context, match) => {
    const event = match.event
    if (event.type !== 'turn/end' || event.data.reason.kind !== 'request-budget') {
      throw new Error('turn-request-budget requires a request-budget turn/end')
    }
    return {
      kind: 'turn-request-budget', seq: event.seq, time: event.time,
      turn: event.data.turn, step: 0, budget: event.data.reason.budget,
    }
  },
  update: context => context.state,
  buildViewNode: (context) => {
    if (context.state === undefined) return null
    const position = turnNoticePosition(context, context.state.seq)
    return chatNode(context, 'turn-request-budget', position.anchor, { ...context.state, step: position.step })
  },
}

/** Register the host-budget pause as a persistent conversation notice. */
export function registerTurnRequestBudgetConversationNode(ctx: Context): void {
  ctx.uiConversation.events.register(turnRequestBudgetDefinition)
}
