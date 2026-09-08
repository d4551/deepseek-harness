/** Serialized Team transactions over the exact live Lead Session log. */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { KeyedLock } from '@deepseek-ai/dsh-keyed-lock'
import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEventMap, SessionId } from '@deepseek-ai/dsh-session'
import { applyTeamEvent, emptyTeamFoldState } from './fold.ts'
import type { TeamEventType, TeamFoldState } from './fold.ts'

type TeamAppend = {
  [T in TeamEventType]: [root: Agent, type: T, data: SessionEventMap[T]]
}[TeamEventType]

interface ReplayPosition {
  readonly state: TeamFoldState
  seq: number
}

/** Owns per-Lead transaction order and committed Team event publication. */
export class TeamJournal {
  private readonly mutations = new KeyedLock()
  private readonly replays = new WeakMap<Session, ReplayPosition>()

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
    const session = root.session
    let replay = this.replays.get(session)
    if (replay === undefined) {
      replay = { state: emptyTeamFoldState(session.id), seq: 0 }
      this.replays.set(session, replay)
    }
    if (replay.seq < session.seq) {
      for (const event of session.events.slice(replay.seq)) {
        applyTeamEvent(replay.state, event)
        replay.seq += 1
      }
    }
    return structuredClone(replay.state)
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
   * If flush rejects, the event remains in the in-memory log, its durability
   * is unconfirmed, and `onCommit` is not called.
   * @param event - exact live Lead, Team event type, and its correlated payload.
   * @returns after the flush and commit notification succeed.
   */
  async appendAndFlush(...event: TeamAppend): Promise<void> {
    const [root, type, data] = event
    root.session.append<TeamEventType>(type, data)
    await this.ctx.sessions.flush(root.session)
    this.onCommit(root)
  }
}
