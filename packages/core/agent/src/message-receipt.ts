/** Read producer receipts against the recipient's durable inbox lifecycle. */

import { isDeepStrictEqual } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import type { Agent } from './types.ts'
import type {} from './runtime-types.ts'

/** Native owners that publish model-facing continuation input. */
export type MessageProducer = 'subagent' | 'agent-team'

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Exact native producer output, recorded before its recipient inbox insertion. */
    'agent/message/produced': {
      readonly producer: MessageProducer
      readonly message: UserMessage
    }
  }
}

/** Whether a receipt has exactly one current claim and has never been consumed or canceled. */
function claimedReceipt(events: readonly SessionEvent[], message: UserMessage, producer: MessageProducer): boolean {
  const inbox: Record<'next-turn' | 'next-step', UserMessage[]> = { 'next-turn': [], 'next-step': [] }
  let phase: 'absent' | 'produced' | 'queued' | 'claimed' = 'absent'
  for (const event of events) {
    if (event.type === 'agent/message/produced' && event.data.message.id === message.id) {
      if (phase !== 'absent' || event.data.producer !== producer
        || !isDeepStrictEqual(event.data.message, message)) return false
      phase = 'produced'
    }
    if (event.type === 'agent/inbox/spliced') {
      const splice = event.data
      const removed = inbox[splice.target].splice(splice.start, splice.removedCount ?? 0, ...splice.inserted)
      if (removed.some(item => item.id === message.id)) {
        if (phase !== 'queued' || splice.outcome !== undefined) return false
        phase = 'claimed'
      }
      for (const inserted of splice.inserted) {
        if (inserted.id !== message.id) continue
        if (phase !== 'produced' || !isDeepStrictEqual(inserted, message)) return false
        phase = 'queued'
      }
    }
    if (event.type === 'user/message' && event.data.id === message.id) return false
    if (event.type === 'turn/end' && phase === 'claimed') return false
  }
  return phase === 'claimed'
}

/**
 * Verify one native producer's exact, currently claimed envelope. Native Session
 * appenders are trusted process collaborators; attribution fields and inbox
 * insertion alone do not create a producer receipt. Fork seeds never transfer
 * receipt authority, while native persistence preserves unconsumed receipts.
 * @param ctx - native Agent and Session registries.
 * @param agent - exact live recipient.
 * @param message - complete original envelope claimed for the proposed step.
 * @param producer - the native producer whose receipt must precede insertion.
 * @returns whether that producer owns this unconsumed exact claim.
 */
export function isProducedMessage(
  ctx: Context,
  agent: Agent,
  message: UserMessage,
  producer: MessageProducer,
): boolean {
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  if (agents === undefined || sessions === undefined
    || agents.get(agent.id) !== agent || sessions.get(agent.id) !== agent.session) return false
  return claimedReceipt(agent.session.events.slice(agent.session.header.seedLength ?? 0), message, producer)
}
