import type {
  ConversationLocation, ConversationNodeContext,
} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {
  ChatNode, ChatNodeDataMap, ChatNodeKind,
} from '../contract/chat-nodes.ts'
import { SYNTHETIC_SEQ_OFFSETS } from '@deepseek-ai/dsh-client-ui-projection'
import { publishedTurnTail } from './location-data.ts'

/** Position a turn-limit notice before its tail and retain its final step. */
export function turnNoticePosition(context: ConversationNodeContext, seq: number): { anchor: number; step: number } {
  const location = contextLocation(context)
  if (location.kind !== 'turn' && location.kind !== 'step') return { anchor: seq, step: 0 }
  const closing = publishedTurnTail(location.turn.data.get('turn-tail'))?.closing
  return {
    anchor: closing === null || closing === undefined
      ? seq
      : closing.finalNode.seq + SYNTHETIC_SEQ_OFFSETS.maxTokensNotice,
    step: location.turn.steps.at(-1)?.step ?? 0,
  }
}

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
