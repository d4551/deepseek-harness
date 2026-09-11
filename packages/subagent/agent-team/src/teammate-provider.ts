import type { Context } from '@deepseek-ai/cordis'
import type { SubagentProvider } from '@deepseek-ai/dsh-subagent'
import { TeamError } from './error.ts'
import type { SpawnTeammateRequest } from './types.ts'
import { requiredText } from './validation.ts'

/**
 * Resolve a continuation provider before reserving a durable teammate name.
 * @param ctx - Runtime containing the provider registry.
 * @param request - Requested context mode and optional provider selection.
 * @returns The registered provider that supports the requested continuation.
 */
export function teammateProvider(
  ctx: Context,
  request: Pick<SpawnTeammateRequest, 'context' | 'provider'>,
): SubagentProvider {
  const inheritsParentContext = request.context === 'fork'
  if (request.provider !== undefined) {
    const name = requiredText(request.provider, 'provider', 200)
    const provider = ctx.subagents.getProvider(name)
    if (provider === undefined) {
      throw new TeamError(`Team provider "${request.provider}" is not registered`, 'TEAM_PROVIDER_UNAVAILABLE')
    }
    if (provider.prepareContinuable === undefined || provider.inheritsParentContext !== inheritsParentContext) {
      throw new TeamError(
        `Team provider "${provider.name}" cannot create a ${request.context} continuation`,
        'TEAM_PROVIDER_CONTEXT',
      )
    }
    return provider
  }
  const candidates = ctx.subagents.list().flatMap((name) => {
    const provider = ctx.subagents.getProvider(name)
    return provider?.prepareContinuable !== undefined && provider.inheritsParentContext === inheritsParentContext
      ? [provider]
      : []
  })
  const [provider] = candidates
  if (candidates.length !== 1 || provider === undefined) {
    throw new TeamError(
      `Team ${request.context} continuation requires one registered provider; found ${candidates.length}. Configure its provider explicitly.`,
      'TEAM_PROVIDER_AMBIGUOUS',
    )
  }
  return provider
}
