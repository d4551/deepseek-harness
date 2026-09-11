import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent-team'

/**
 * Register request submission for a lead whose composition supplies swarm policy.
 * @param owner - the agent receiving the scoped command.
 * @returns the disposer for its command registration.
 */
export function installSwarmCommand(owner: Agent): () => Promise<void> {
  return owner.ctx.inject(['commands', 'agentTeams'], (ctx) => {
    if (ctx.agentTeams.tryMembership(owner)?.role !== 'lead') return
    ctx.commands.register({
      name: 'swarm',
      description: 'Ask this swarm to coordinate a request',
      input: { hint: '<request>', images: true },
      handler: ({ agent, rawInput, attachments }) => {
        if (agent !== owner || ctx.agentTeams.tryMembership(agent)?.role !== 'lead') {
          return { kind: 'error', text: 'Only this swarm’s lead can submit a swarm request.' }
        }
        const request = rawInput.trim()
        if (request === '') {
          return { kind: 'error', text: 'Describe the work after /swarm.' }
        }
        agent.followup(createUserMessage({
          content: [...attachments, { type: 'text', text: `/swarm ${request}` }],
          source: { kind: 'user' },
        }))
        return { kind: 'success', text: 'Swarm request queued.' }
      },
    })
  }).dispose
}
