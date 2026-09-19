/** Session-addressed, cold-readable skill catalog Remote. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-presets/types'
import { effectiveWorkspaceRoots } from '@deepseek-ai/dsh-session/workspace-roots'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { SessionQueryError } from '@deepseek-ai/dsh-session-query'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { Remote, TypertRemoteFailure, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { SkillListRequest, SkillListValue } from './types.ts'

import type { Thrown } from '@deepseek-ai/dsh-thrown'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the Session-addressed `skills` Remote namespace. */
    sessionSkillCatalog: SessionSkillCatalog
  }
}

/** Host service backing `ctx.remote.skills` without activating a cold Agent. */
export class SessionSkillCatalog extends TypertRemoteService {
  static inject = ['agents', 'sessionQuery', 'typert']

  /** @param ctx - Host context carrying Session reads and optional skill/preset services. */
  constructor(ctx: Context) {
    super(ctx, 'sessionSkillCatalog', { namespace: 'skills' })
  }

  /**
   * List the user-invocable skills visible to one Session composition.
   * @param request - Session identity whose cwd and preset select the catalog view.
   * @param signal - caller lifetime carried by the Remote transport.
   * @returns user-invocable skill metadata without loading skill bodies.
   * @throws TypertRemoteFailure when the Session cannot be inspected or no registry can serve it.
   */
  @Remote
  async list(request: SkillListRequest, signal: AbortSignal): Promise<SkillListValue> {
    signal.throwIfAborted()
    const { sessionId } = request
    const inspected = await this.ctx.sessionQuery.observeSession(sessionId).then(
      (observation) => {
        using owned = observation
        if (owned.projections === undefined) {
          throw new Error('skill catalog requires a projected Session observation')
        }
        const cwd = owned.header.cwd
        return {
          cwd,
          // The human catalog spans the same directories the model's does: a user
          // who adds a second folder expects its `/name` skills to appear.
          additionalRoots: effectiveWorkspaceRoots(owned.events).filter((root: string) => root !== cwd),
          agentPreset: owned.projections.values.agentPreset ?? undefined,
        }
      },
    ).then(undefined, (error: Thrown) => {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') {
        throw failure(
          'session-not-found',
          `session "${sessionId}" not found`,
          { sessionId },
        )
      }
      throw failure(
        'internal',
        `session "${sessionId}" could not be inspected: ${String(error)}`,
      )
    })
    const { cwd, additionalRoots, agentPreset } = inspected
    if (cwd === undefined) {
      throw failure('internal', `session "${sessionId}" has no project cwd`)
    }

    const live = this.ctx.agents.get(sessionId)
    const presets = this.ctx.get('agentPresets')
    const scoped = live === undefined ? undefined : presets?.serviceFor(live, 'skills')
    const skillRegistry = scoped ?? this.ctx.get('skills')
    if (skillRegistry === undefined) {
      throw failure(
        'internal',
        'skill registry is absent: neither this session\'s agent preset nor the host composition mounts @deepseek-ai/dsh-skill',
      )
    }

    const scope = await this.scopeFor(sessionId, agentPreset)
    const skills = await skillRegistry.list({ cwd, additionalRoots, scope }).then(
      listed => listed.filter(isUserInvocable),
      (error: Thrown) => {
        throw failure('internal', `skill listing failed: ${String(error)}`)
      },
    )
    return {
      skills: skills.map(skill => ({
        name: skill.name,
        description: skill.description,
        ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
        modelInvocable: skill.invocation.modelInvocable,
      })),
    }
  }

  /** Resolve a live or standing preset scope without creating an Agent. */
  private async scopeFor(
    sessionId: SessionId,
    agentPreset: string | undefined,
  ): Promise<ScopeKey | undefined> {
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) return live
    const presets = this.ctx.get('agentPresets')
    if (presets === undefined) return undefined
    // An unusable recorded preset falls back to the global registry.
    return await presets.standingKeyFor(agentPreset).then(
      undefined,
      (_error: Thrown) => undefined,
    )
  }
}

/** Build one stable Remote failure with optional typed details. */
function failure(
  code: 'session-not-found' | 'internal',
  message: string,
  details: { readonly sessionId: SessionId } | Record<never, never> = {},
): TypertRemoteFailure {
  return new TypertRemoteFailure({ code, message, details })
}

export default SessionSkillCatalog
