import type { MessageId } from '@deepseek-ai/dsh-llm'
import type { Session, SessionStore } from './index.ts'
import type { SessionId } from './types.ts'
import type { RequestAttempt, RequestBudgetPolicy, RequestEpisode } from './request-budget-types.ts'

interface EpisodeState {
  readonly identity: RequestEpisode
  readonly inputSequence: number
  readonly actors: Map<SessionId, number>
  total: number
}

interface BudgetBook {
  cursor: number
  readonly humanMessages: Map<MessageId, number>
  readonly admittedMessages: Set<string>
  readonly policies: Map<string, EpisodeState>
  readonly offeredMessages: Map<string, Set<MessageId>>
  barrier: Promise<readonly PromiseSettledResult<void>[]>
}

function requireText(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    throw new Error('request budget identity must be nonempty text')
  }
}

function requirePositive(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error('request budget counter must be a positive safe integer')
  }
}

function requirePolicy(policy: RequestBudgetPolicy): void {
  requireText(policy.policyId)
  requirePositive(policy.maxAgentAttempts)
  requirePositive(policy.maxRootAttempts)
}

function requireIdentity(value: unknown, root: Session, fields: number): asserts value is RequestEpisode {
  if (value === null || typeof value !== 'object' || Object.keys(value).length !== fields
    || !('version' in value) || value.version !== 1
    || !('policyId' in value) || !('rootSessionId' in value) || !('userMessageId' in value)) {
    throw new Error('request budget event has invalid fields or version')
  }
  requireText(value.policyId)
  requireText(value.rootSessionId)
  requireText(value.userMessageId)
  if (value.rootSessionId !== root.id) throw new Error('request budget event belongs to another root')
}

function messageKey(identity: RequestEpisode): string {
  return JSON.stringify([identity.policyId, identity.userMessageId])
}

function validateEpisode(book: BudgetBook, root: Session, identity: RequestEpisode): number {
  requireIdentity(identity, root, 4)
  const inputSequence = book.humanMessages.get(identity.userMessageId)
  if (inputSequence === undefined) throw new Error('request episode lacks an earlier root human message')
  if (book.admittedMessages.has(messageKey(identity))) throw new Error('request episode repeats an admitted message')
  const previous = book.policies.get(identity.policyId)
  if (previous !== undefined && inputSequence <= previous.inputSequence) {
    throw new Error('request episode cannot renew from an older human message')
  }
  return inputSequence
}

function acceptEpisode(book: BudgetBook, root: Session, identity: RequestEpisode): void {
  const inputSequence = validateEpisode(book, root, identity)
  book.admittedMessages.add(messageKey(identity))
  book.policies.set(identity.policyId, { identity, inputSequence, actors: new Map(), total: 0 })
}

function acceptAttempt(book: BudgetBook, root: Session, attempt: RequestAttempt): void {
  requireIdentity(attempt, root, 7)
  requireText(attempt.actorSessionId)
  requirePositive(attempt.actorAttempt)
  requirePositive(attempt.rootAttempt)
  const episode = book.policies.get(attempt.policyId)
  if (episode === undefined || episode.identity.userMessageId !== attempt.userMessageId) {
    throw new Error('request attempt does not belong to the current episode')
  }
  if (attempt.rootAttempt !== episode.total + 1
    || attempt.actorAttempt !== (episode.actors.get(attempt.actorSessionId) ?? 0) + 1) {
    throw new Error('request attempt counters are not consecutive')
  }
  episode.total = attempt.rootAttempt
  episode.actors.set(attempt.actorSessionId, attempt.actorAttempt)
}

/** Canonical root-log reservation owner; deployment code authenticates admission and lineage. */
export class SessionRequestBudgets {
  private readonly books = new WeakMap<Session, BudgetBook>()

  constructor(private readonly sessions: SessionStore) {}

  /** Replay immutable root history once, then fold only newly appended events. */
  private book(root: Session): BudgetBook {
    if (this.sessions.get(root.id) !== root) throw new Error('request budget root is not the exact live session')
    let book = this.books.get(root)
    if (book === undefined) {
      book = {
        cursor: root.header.seedLength ?? 0,
        humanMessages: new Map(), admittedMessages: new Set(), policies: new Map(),
        offeredMessages: new Map(), barrier: Promise.resolve([]),
      }
      this.books.set(root, book)
    }
    for (const event of root.events.slice(book.cursor)) {
      if (event.type === 'user/message' && event.data.source.kind === 'user'
        && !book.humanMessages.has(event.data.id)) book.humanMessages.set(event.data.id, event.seq)
      if (event.type === 'request/episode') acceptEpisode(book, root, event.data)
      if (event.type === 'request/attempt') acceptAttempt(book, root, event.data)
      book.cursor = event.seq + 1
    }
    return book
  }

  /**
   * Retain prospective host admission at live inbox insertion, before log acceptance.
   * @param root - exact authenticated root Session.
   * @param policy - deployment-owned policy.
   * @param userMessageId - newly inserted human message identity.
   */
  offer(root: Session, policy: RequestBudgetPolicy, userMessageId: MessageId): void {
    requirePolicy(policy)
    requireText(userMessageId)
    const book = this.book(root)
    if (book.humanMessages.has(userMessageId)) throw new Error('request admission cannot relabel historical input')
    let offered = book.offeredMessages.get(policy.policyId)
    if (offered === undefined) {
      offered = new Set()
      book.offeredMessages.set(policy.policyId, offered)
    }
    offered.add(userMessageId)
  }

  /**
   * Revoke a prospective admission when its live inbox message is discarded.
   * @param root - exact root Session.
   * @param policy - deployment-owned policy.
   * @param userMessageId - discarded message identity.
   */
  discard(root: Session, policy: RequestBudgetPolicy, userMessageId: MessageId): void {
    requirePolicy(policy)
    this.book(root).offeredMessages.get(policy.policyId)?.delete(userMessageId)
  }

  private acceptOffers(root: Session, policy: RequestBudgetPolicy, book: BudgetBook): void {
    const offered = book.offeredMessages.get(policy.policyId)
    if (offered === undefined || offered.size === 0) return
    for (const event of root.events.slice(root.header.seedLength ?? 0)) {
      if (event.type !== 'user/message' || !offered.has(event.data.id)) continue
      this.admit(root, policy, event.data.id)
      offered.delete(event.data.id)
    }
  }

  /**
   * Record a host-authenticated, already logged human input as a new episode.
   * @param root - exact live root Session.
   * @param policy - deployment-owned policy.
   * @param userMessageId - admitted root message identity, never inferred from model text.
   */
  admit(root: Session, policy: RequestBudgetPolicy, userMessageId: MessageId): void {
    requirePolicy(policy)
    const book = this.book(root)
    const identity: RequestEpisode = { version: 1, policyId: policy.policyId, rootSessionId: root.id, userMessageId }
    validateEpisode(book, root, identity)
    root.append('request/episode', identity)
    this.book(root)
  }

  /**
   * Reserve synchronously, then serialize durable root checkpoints before returning.
   * @param root - exact root Session authenticated by the deployment.
   * @param actor - exact live actor Session in that root's delegated tree.
   * @param policy - deployment-owned finite limits.
   * @param signal - request cancellation; an accepted reservation is never refunded.
   * @returns the committed charge after a real durability listener succeeds.
   */
  async reserve(root: Session, actor: Session, policy: RequestBudgetPolicy, signal: AbortSignal): Promise<RequestAttempt> {
    signal.throwIfAborted()
    requirePolicy(policy)
    if (this.sessions.get(actor.id) !== actor) throw new Error('request budget actor is not the exact live session')
    const book = this.book(root)
    this.acceptOffers(root, policy, book)
    const episode = book.policies.get(policy.policyId)
    if (episode === undefined) throw new Error('HOST_REQUEST_BUDGET: a new authenticated human work message is required')
    const actorCount = episode.actors.get(actor.id) ?? 0
    if (actorCount >= policy.maxAgentAttempts || episode.total >= policy.maxRootAttempts) {
      throw new Error(
        `HOST_REQUEST_BUDGET: agent ${actor.id} used ${actorCount}/${policy.maxAgentAttempts}; `
        + `root ${root.id} used ${episode.total}/${policy.maxRootAttempts} attempts for ${episode.identity.userMessageId}. `
        + 'Automatic work stopped; existing quality debt remains uncertified and unpaid. Submit an explicit human follow-up to authorize more work.',
      )
    }
    const attempt: RequestAttempt = {
      ...episode.identity, actorSessionId: actor.id, actorAttempt: actorCount + 1, rootAttempt: episode.total + 1,
    }
    root.append('request/attempt', attempt)
    this.book(root)
    const barrier = book.barrier.then(async () => {
      if (!await this.sessions.flush(root)) throw new Error('HOST_REQUEST_BUDGET: root reservation has no durability provider')
    })
    book.barrier = Promise.allSettled([barrier])
    await barrier
    signal.throwIfAborted()
    if (this.sessions.get(actor.id) !== actor || this.sessions.get(root.id) !== root) {
      throw new Error('request budget ownership changed during durability checkpoint')
    }
    return Object.freeze(attempt)
  }
}
