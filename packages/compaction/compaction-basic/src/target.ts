/**
 * Routed-target resolution shared by pressure policy, overflow recovery, and
 * the default summarizer.
 *
 * @module @deepseek-ai/dsh-compaction-basic/target
 */

import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * Resolve the exact provider/model durably routed for the latest request.
 * @param session - session whose latest durable request header is read.
 * @returns the routed provider/model pair, or `undefined` when no complete route is logged.
 */
export function routedTarget(
  session: Session,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const config = session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) {
    return undefined
  }
  return { provider: config.provider, model: config.model }
}

/**
 * Resolve the conversation target used to select an optional policy override.
 * @param agent - agent supplying the session and the agent option pair.
 * @returns the routed or option provider/model pair, or `undefined` when neither is complete.
 */
export function conversationTarget(
  agent: Agent,
): Pick<LlmCallConfig, 'provider' | 'model'> | undefined {
  const routed = routedTarget(agent.session)
  if (routed !== undefined) return routed
  if (agent.options.provider === undefined || agent.options.provider.length === 0
    || agent.options.model === undefined || agent.options.model.length === 0) return undefined
  return { provider: agent.options.provider, model: agent.options.model }
}
