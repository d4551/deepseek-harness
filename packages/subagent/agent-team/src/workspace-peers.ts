import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-workspace'
import type { TeamRoster } from './roster.ts'

/**
 * Name an independently owned workspace conversation for message routing.
 * @param id - Registered conversation identity.
 * @returns its stable, session-qualified message target.
 */
export function workspacePeerName(id: SessionId): string {
  return `session:${id}`
}

/**
 * Discover live conversation leads through validated registry membership.
 * @param ctx - Host services containing live agents and the optional workspace registry.
 * @param roster - Team identity owner.
 * @param root - Exact live conversation lead.
 * @returns unarchived live peers in the same registered workspace.
 */
export function workspacePeers(ctx: Context, roster: TeamRoster, root: Agent): Agent[] {
  if (ctx.agents.get(root.id) !== root) return []
  return workspacePeerIds(ctx, root.id).flatMap((id) => {
    const peer = ctx.agents.get(id)
    if (peer === undefined || roster.tryMembership(peer)?.role !== 'lead') return []
    return [peer]
  })
}

/**
 * Resolve peer identities for roster invalidation, including a departing session.
 * @param ctx - Host services containing the optional workspace registry.
 * @param rootId - Conversation identity whose registered workspace is selected.
 * @returns unarchived peer identities, or an empty set when membership is absent or ambiguous.
 */
export function workspacePeerIds(ctx: Context, rootId: SessionId): SessionId[] {
  const registry = ctx.get('workspaceRegistry')
  if (registry === undefined || registry.archivedSessionIds.includes(rootId)) return []
  const workspaces = registry.list().filter(workspace => workspace.sessionIds.includes(rootId))
  if (workspaces.length !== 1) return []
  return workspaces.flatMap(workspace =>
    workspace.sessionIds.filter(id => id !== rootId && !registry.archivedSessionIds.includes(id)))
}
