/** Complete dependency validation for current Team task snapshots. */

import type { TeamTaskId, TeamTaskSnapshot } from './types.ts'
import { TeamError } from './error.ts'

/**
 * Validate the complete active task graph after replacing one candidate snapshot.
 * @param current - current task snapshots before the candidate event.
 * @param candidate - new or next-revision task snapshot.
 * @throws {TeamError} when an active dependency is missing, duplicated, self-referential, or cyclic.
 */
export function assertTaskGraphCandidate(
  current: ReadonlyMap<TeamTaskId, TeamTaskSnapshot>,
  candidate: TeamTaskSnapshot,
): void {
  const tasks = new Map(current)
  tasks.set(candidate.id, candidate)

  for (const task of tasks.values()) {
    if (task.status === 'deleted') continue
    const seen = new Set<TeamTaskId>()
    for (const blockerId of task.blockedBy) {
      if (blockerId === task.id) {
        throw new TeamError(`team task "${task.id}" cannot block itself`, 'TEAM_TASK_DEPENDENCY_CYCLE')
      }
      if (seen.has(blockerId)) {
        throw new TeamError(`team task "${task.id}" repeats blocker "${blockerId}"`, 'TEAM_INVALID_ARGUMENT')
      }
      const blocker = tasks.get(blockerId)
      if (blocker === undefined || blocker.status === 'deleted') {
        throw new TeamError(
          `blocker task "${blockerId}" for "${task.id}" is missing or deleted`,
          'TEAM_TASK_NOT_FOUND',
        )
      }
      seen.add(blockerId)
    }
  }

  const visiting = new Set<TeamTaskId>()
  const visited = new Set<TeamTaskId>()
  const visit = (id: TeamTaskId): void => {
    if (visiting.has(id)) {
      throw new TeamError(`task dependency cycle includes "${id}"`, 'TEAM_TASK_DEPENDENCY_CYCLE')
    }
    if (visited.has(id)) return
    const task = tasks.get(id)
    if (task === undefined || task.status === 'deleted') return
    visiting.add(id)
    for (const blockerId of task.blockedBy) visit(blockerId)
    visiting.delete(id)
    visited.add(id)
  }
  for (const task of tasks.values()) visit(task.id)
}
