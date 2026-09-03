import type {
  ConversationLocation, ConversationNodeContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatNode, ChatNodeDataMap, ChatNodeKind,
} from '../contract/chat-nodes.ts'

/**
 * Resolve one Context's best currently loaded event Location.
 * @param context - assembled business Context.
 * @returns start or first-match Location, otherwise unresolved.
 */
export function contextLocation(context: ConversationNodeContext): ConversationLocation {
  return context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' }
}

/**
 * Build one final Chat target Node with the engine-owned stable key.
 * @param context - assembled business Context.
 * @param kind - Chat renderer dispatch key.
 * @param anchorSeq - sortable render position.
 * @param data - renderer-owned payload.
 * @param options - optional Location and visibility overrides.
 * @returns final Chat view Node.
 */
export function chatNode<Kind extends ChatNodeKind>(
  context: ConversationNodeContext,
  kind: Kind,
  anchorSeq: number,
  data: ChatNodeDataMap[Kind],
  options: {
    readonly location?: ConversationLocation
    readonly visibility?: 'visible' | 'hidden'
  } = {},
): ChatNode<Kind> {
  return {
    key: context.key,
    kind,
    id: context.id,
    target: 'chat',
    anchorSeq,
    location: options.location ?? contextLocation(context),
    visibility: options.visibility ?? 'visible',
    data,
  }
}

/**
 * Read a finite non-negative integer from a structurally narrowed payload.
 * @param value - untrusted payload field.
 * @returns valid coordinate, otherwise undefined.
 */
export function coordinate(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined
}
