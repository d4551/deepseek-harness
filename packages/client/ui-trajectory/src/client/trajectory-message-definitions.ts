import type { Context } from '@deepseek-ai/cordis'
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import {
  applyInboxSplice, inputMessageNode, type InboxState, type InputMessageNode,
} from '@deepseek-ai/dsh-client-ui-projection'
import type {} from '@deepseek-ai/dsh-agent/types'
import { trajectoryNode } from './trajectory-definition-common.ts'

/** Inbox Context whose claims this target's message classification reads. */
const INBOX_KIND = 'trajectory-inbox-next-step'

const trajectoryInboxDefinition: ConversationNodeDefinition<InboxState> = {
  kind: INBOX_KIND,
  match: event => event.type === 'agent/inbox/spliced'
    && event.data.target === 'next-step'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'agent/inbox/spliced') {
      throw new Error(`${INBOX_KIND} start requires agent/inbox/spliced`)
    }
    return applyInboxSplice(reader.previous<InboxState>(INBOX_KIND), match.event.data)
  },
  update: context => context.state,
  publication: () => 'none',
}

const trajectoryMessageDefinition: ConversationNodeDefinition<InputMessageNode> = {
  kind: 'trajectory-input-message',
  target: 'trajectory',
  match: event => event.type === 'user/message'
    ? { id: String(event.seq), role: 'start' }
    : null,
  start: (_context, match, reader) => {
    if (match.event.type !== 'user/message') {
      throw new Error('trajectory-input-message start requires user/message')
    }
    const event = match.event
    const claimed = reader.previous<InboxState>(INBOX_KIND)
      ?.state.claimed.has(String(event.data.id)) === true
    return inputMessageNode(event, claimed)
  },
  update: context => context.state,
  buildViewNode: context => context.state === undefined
    ? null
    : trajectoryNode(context, context.state.seq, { kind: 'node', node: context.state }),
}

/**
 * Register Trajectory-owned inbox classification and message records.
 *
 * @param ctx - Plugin context receiving the Definitions.
 */
export function registerTrajectoryMessageDefinitions(ctx: Context): void {
  ctx.uiConversation.events.register(trajectoryInboxDefinition)
  ctx.uiConversation.events.register(trajectoryMessageDefinition)
}
