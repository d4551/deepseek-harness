import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { SessionId } from './types.ts'

/** Deployment-owned request limits; model input cannot supply this policy. */
export interface RequestBudgetPolicy {
  readonly policyId: string
  readonly maxAgentAttempts: number
  readonly maxRootAttempts: number
}

/** One host-admitted human work episode, retained in its root Session log. */
export interface RequestEpisode {
  readonly version: 1
  readonly policyId: string
  readonly rootSessionId: SessionId
  readonly userMessageId: MessageId
}

/** Irrevocable reservation recorded before a provider attempt may begin. */
export interface RequestAttempt extends RequestEpisode {
  readonly actorSessionId: SessionId
  readonly actorAttempt: number
  readonly rootAttempt: number
}

/** Exact usage at a denied provider reservation; no new attempt was charged. */
export interface RequestBudgetExhaustion extends RequestEpisode {
  readonly actorSessionId: SessionId
  readonly actorAttempts: number
  readonly rootAttempts: number
  readonly maxAgentAttempts: number
  readonly maxRootAttempts: number
}

declare module '@deepseek-ai/dsh-session/types' {
  interface TurnEndReasonMap {
    /** Work awaits a new host-authenticated human message; prior charges remain. */
    'request-budget': { kind: 'request-budget'; budget: RequestBudgetExhaustion }
  }

  interface SessionEventMap {
    /**
     * Host admission of a new human work episode. The referenced root user
     * message must already be logged. Producer authentication precedes this
     * record; a message source label alone does not grant admission.
     */
    'request/episode': RequestEpisode
    /**
     * Reserved provider attempt, charged to an actor and its root episode.
     * This record lives in the root log, which may be idle while a descendant
     * owns the request. Reservations survive failure, cancellation, and resume.
     * Successful root-log durability is mandatory before provider dispatch.
     */
    'request/attempt': RequestAttempt
  }
}
