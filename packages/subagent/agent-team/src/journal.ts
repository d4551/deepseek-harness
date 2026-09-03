/** Serialized Team transactions over the exact live Lead Session log. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { KeyedLock } from '@deepseek-ai/dsh-keyed-lock'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { foldTeam } from './fold.ts'
import type { TeamEventType, TeamFoldState } from './fold.ts'

type AppendTeamEvent = <T extends TeamEventType>(type: T, data: SessionEventMap[T]) => void
type MutableTeamEventType = 'team/member' | 'team/task' | 'team/message/queued' | 'team/message/delivered'

/** Owns per-Lead transaction order and committed Team event publication. */
export class TeamJournal {
  private readonly mutations = new KeyedLock()

  /**
   * @param ctx - Team service context with the injected Session service.
   * @param onCommit - synchronous notification after the Team event flush succeeds.
   */
  constructor(
    private readonly ctx: Context,
    private readonly onCommit: (root: Agent) => void,
  ) {}

  /**
   * Fold authoritative Team state for one exact live Lead.
   * @param root - exact live Team Lead.
   * @returns current replay state selected by the Lead Team id.
   */
  state(root: Agent): TeamFoldState {
    return foldTeam(root.id, root.session.events)
  }

  /**
   * Serialize one Lead's asynchronous mutation operation.
   *
   * The serialization is a promise chain in this process, so it excludes
   * concurrent callers here and is not a lock a second process could join.
   * @param rootId - Lead Session identity selecting the transaction queue.
   * @param operation - complete read-check-append operation.
   * @returns the operation result.
   */
  async transact<T>(rootId: SessionId, operation: () => Promise<T>): Promise<T> {
    return await this.mutations.run(String(rootId), operation)
  }

  /**
   * Append and checkpoint one root-owned Team event before publication.
   *
   * `append` commits to the session's authoritative in-memory log and `flush`
   * is the durability boundary, which is the seam's ordering everywhere. A
   * rejected flush therefore reaches the caller with the event already folded
   * into Team state: the operation is visible to this process and will not
   * survive a restart, and `onCommit` does not run, so nothing downstream
   * observes it as committed.
   * @param root - exact live Lead whose Session owns the event.
   * @param type - Team event discriminant.
   * @param data - payload correlated with the event type.
   */
  async appendAndFlush<T extends MutableTeamEventType>(
    root: Agent,
    type: T,
    data: SessionEventMap[T],
  ): Promise<void> {
    // Team events never enter the conversation surface. This narrower local
    // capability removes Session.append's conditional surface argument while
    // preserving the event-key/payload correlation.
    const append = root.session.append.bind(root.session) as unknown as AppendTeamEvent
    append(type, data)
    await this.ctx.sessions.flush(root.session)
    this.onCommit(root)
  }
}
