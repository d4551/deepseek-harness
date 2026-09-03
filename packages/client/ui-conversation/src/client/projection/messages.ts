/**
 * Inbox-state and input-message projection shared by every Conversation target:
 * the cumulative fold over `agent/inbox/spliced` that decides which message ids
 * were admitted mid-turn, and the classification of one `user/message` into a
 * user, steering, or context record.
 * @module @deepseek-ai/dsh-client-ui-conversation/src/client/projection/messages
 */

import type { ConversationMatch, ConversationPreviousContext } from '../contract/conversation.ts'
import type {
  ContextMessageNode, SteeringMessageNode, UserMessageNode,
} from '../contract/records.ts'
import { contextForm, contextProvenance } from './event-projection.ts'

/** One queued message identity carried by an inbox splice. */
interface InboxIdentity {
  readonly id: string
}

/** The `agent/inbox/spliced` fields the cumulative fold reads. */
export interface InboxSplice {
  readonly target: string
  readonly start: number
  readonly removedCount?: number
  readonly inserted: readonly InboxIdentity[]
  readonly outcome?: 'canceled'
}

/** Cumulative inbox state after one durable splice. */
export interface InboxState {
  /** Queued identities still waiting, in queue order. */
  readonly pending: readonly InboxIdentity[]
  /** Identities a completed next-step splice admitted into a running turn. */
  readonly claimed: ReadonlySet<string>
}

/**
 * Advance the cumulative inbox state by one durable splice. A next-step splice
 * that was not canceled claims what it removed: those ids arrived mid-turn and
 * their messages render as steering rather than as a new turn.
 * @param previous - the Context's previous cumulative state, when it has one.
 * @param splice - the logged splice.
 * @returns the next cumulative state.
 */
export function applyInboxSplice(
  previous: ConversationPreviousContext<InboxState> | undefined,
  splice: InboxSplice,
): InboxState {
  const pending = [...(previous?.state.pending ?? [])]
  const claimed = new Set(previous?.state.claimed ?? [])
  const removed = pending.splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
  for (const identity of splice.inserted) claimed.delete(identity.id)
  if (splice.target === 'next-step' && splice.outcome !== 'canceled') {
    for (const identity of removed) claimed.add(identity.id)
  }
  return { pending, claimed }
}

/** The three records one durable `user/message` projects to. */
export type InputMessageNode = UserMessageNode | SteeringMessageNode | ContextMessageNode

/**
 * Classify one durable `user/message` as a user, steering, or context record.
 * A non-user source is context and carries its projected provenance and form;
 * a user source is steering when the next-step inbox already claimed its id.
 * @param event - the matched `user/message` event.
 * @param claimed - whether the next-step inbox admitted this message mid-turn.
 * @returns the classified record.
 */
export function inputMessageNode(
  event: Extract<ConversationMatch['event'], { type: 'user/message' }>,
  claimed: boolean,
): InputMessageNode {
  if (event.data.source.kind !== 'user') {
    return {
      kind: 'context',
      seq: event.seq,
      time: event.time,
      content: event.data.content,
      source: event.data.source,
      provenance: contextProvenance(event.data.source),
      form: contextForm(event.data.source),
    }
  }
  return claimed
    ? {
      kind: 'steering',
      messageId: event.data.id,
      seq: event.seq,
      time: event.time,
      content: event.data.content,
      source: event.data.source,
    }
    : {
      kind: 'user',
      seq: event.seq,
      time: event.time,
      content: event.data.content,
      source: event.data.source,
    }
}
