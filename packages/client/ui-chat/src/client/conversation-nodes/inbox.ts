import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { applyInboxSplice, type InboxState } from '@deepseek-ai/dsh-client-ui-projection'
import type { InboxTarget } from '@deepseek-ai/dsh-agent/types'

function inboxDefinition(target: InboxTarget): ConversationNodeDefinition<InboxState> {
  const kind = `inbox-${target}`
  return {
    kind,
    match: event => event.type === 'agent/inbox/spliced'
      && event.data.target === target
      ? { id: String(event.seq), role: 'start' }
      : null,
    start: (_context, match, reader) => {
      if (match.event.type !== 'agent/inbox/spliced') throw new Error(`${kind} start requires agent/inbox/spliced`)
      return applyInboxSplice(reader.previous<InboxState>(kind), match.event.data)
    },
    update: context => context.state,
    publication: () => 'none',
  }
}

/** Cumulative next-turn inbox splice Definition. */
export const nextTurnInboxDefinition = inboxDefinition('next-turn')

/** Cumulative next-step inbox splice Definition used to classify steering. */
export const nextStepInboxDefinition = inboxDefinition('next-step')

/**
 * Register the two durable Inbox-state contributions.
 * @param ctx - owning UI Conversation context.
 */
export function registerInboxConversationNodes(ctx: Context): void {
  ctx.uiConversation.events.register(nextTurnInboxDefinition)
  ctx.uiConversation.events.register(nextStepInboxDefinition)
}
