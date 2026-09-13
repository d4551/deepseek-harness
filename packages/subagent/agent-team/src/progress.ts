/** Model coordination admission and activity cursors owned by the Team runtime. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { assertWaitTimeout, MAX_TEAM_WAIT_MS, type TeamActivity } from './activity.ts'
import { TeamError } from './error.ts'
import type { TeamMembership, TeamRoster } from './roster.ts'
import type { TeamTaskBoard } from './task-board.ts'
import type { TeamId, TeamProgressResult } from './types.ts'

interface PendingWait {
  readonly teamId: TeamId
  readonly sources: ReadonlySet<TeamId>
}

interface QuietWait {
  readonly cursor: string
  readonly duration: number
  readonly elapsed: number
}

/** Prevent circular waits and repeated timeouts without discarding delegated work. */
export class TeamProgress {
  private readonly waiting = new Map<Agent, PendingWait>()
  private readonly timedOut = new WeakMap<Agent, QuietWait>()

  constructor(
    private readonly ctx: Context,
    private readonly activity: TeamActivity,
    private readonly roster: TeamRoster,
    private readonly tasks: TeamTaskBoard,
    private readonly invalidate: (root: Agent) => void,
  ) {}

  /**
   * Whether the exact currently live member is suspended in a coordination wait.
   * @param id - session identity of the member to inspect.
   * @returns whether its live Agent currently owns an admitted wait.
   */
  isWaiting(id: SessionId): boolean {
    const agent = this.ctx.agents.get(id)
    return agent !== undefined && this.waiting.has(agent)
  }

  /**
   * Notify only Teams whose admitted waits depend on this workspace source.
   * @param source - Team whose work made progress.
   */
  notifySource(source: TeamId): void {
    const targets = new Set<TeamId>()
    for (const pending of this.waiting.values()) {
      if (pending.teamId !== source && pending.sources.has(source)) targets.add(pending.teamId)
    }
    for (const target of targets) this.activity.notify(target)
  }

  /**
   * Admit one bounded wait only while another member can advance delegated work.
   * @param caller - exact live Agent requesting the wait.
   * @param membership - caller's current Team membership.
   * @param timeoutMs - requested duration in milliseconds.
   * @param signal - cancellation of this caller's wait.
   * @returns the observed progress cursor, timeout, or admission refusal.
   */
  wait(caller: Agent, membership: TeamMembership, timeoutMs: number, signal: AbortSignal): Promise<TeamProgressResult> {
    assertWaitTimeout(timeoutMs)
    signal.throwIfAborted()
    if (this.waiting.has(caller)) throw new TeamError('this Agent already has a coordination wait', 'TEAM_ALREADY_WAITING')
    const blockers = this.tasks.blockingMembers(membership)
    const sources = new Set([membership.id, ...blockers.map(member => member.teamId)])
    const cursor = this.cursor(sources)
    const candidates = [
      ...this.roster.list(membership),
      ...blockers.map(member => ({ id: member.id, status: this.ctx.agents.get(member.id)?.status })),
    ]
    if (!candidates.some(member => member.id !== caller.id && !this.isWaiting(member.id)
      && (member.status === 'running' || member.status === 'provisioning'))) {
      return Promise.resolve({ timedOut: false, cursor, noProgress: {
        reason: 'no-active-peer',
        message: 'No required Team member can currently make progress: other members are waiting or inactive. Read the task board, perform ready work, or wake the required owner with followup_task. Do not repeat this wait without a concrete state change.',
      } })
    }
    const previous = this.timedOut.get(caller)
    const quiet = previous?.cursor === cursor ? previous : undefined
    const remaining = MAX_TEAM_WAIT_MS - (quiet?.elapsed ?? 0)
    const minimum = Math.min((quiet?.duration ?? 0) * 2, MAX_TEAM_WAIT_MS)
    if (quiet !== undefined && (timeoutMs < minimum || timeoutMs > remaining)) {
      return Promise.resolve({ timedOut: false, cursor, noProgress: {
        reason: 'unchanged-progress',
        message: minimum > remaining
          ? 'The bounded wait budget for this unchanged activity is exhausted. Inspect the required owner, repair or reassign stalled work, or report the unresolved blocker; do not mark it complete.'
          : `Activity is unchanged. Extend a verified running owner's wait to at least ${minimum}ms and at most ${remaining}ms, or inspect the owner and resolve the blocker. Repeated short waits are refused; unresolved work remains open.`,
        minimumTimeoutMs: minimum,
        remainingTimeoutMs: remaining,
      } })
    }
    this.waiting.set(caller, { teamId: membership.id, sources })
    this.invalidate(membership.root)
    return this.activity.wait(membership.id, timeoutMs, signal).then((result) => {
      if (result.timedOut) this.timedOut.set(caller, { cursor, duration: timeoutMs, elapsed: (quiet?.elapsed ?? 0) + timeoutMs })
      return { ...result, cursor: this.cursor(sources) }
    }).finally(() => {
      this.waiting.delete(caller)
      this.invalidate(membership.root)
    })
  }

  /** Deterministic cursor changes only for meaningful activity in relevant Teams. */
  private cursor(sources: ReadonlySet<TeamId>): string {
    return JSON.stringify([...sources].sort().map(id => [id, this.activity.revision(id)]))
  }
}
