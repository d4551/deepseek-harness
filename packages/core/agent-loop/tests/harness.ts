/**
 * Shared composition and driving helpers for the agent-loop suites. Every
 * suite boots the same plugin set against a mock adapter, so the composition
 * lives here rather than once per spec file.
 * @module dsh-agent-loop/tests/harness
 */

import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import type { MockAdapter } from './mock-adapter.ts'

/**
 * Compose the loop against one mock adapter registered on the `mock` provider.
 * @param adapter - scripted adapter answering the suite's requests.
 * @returns the composed context, ready for agent creation.
 */
export async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

/**
 * Reach the driver promise the loop attaches to an agent.
 * @param agent - agent whose driver the suite awaits.
 * @returns the driver's completion promise.
 */
export function driverDone(agent: Agent): Promise<void> {
  return (agent as Agent & { done: Promise<void> }).done
}

/**
 * Queue one user text message on an agent.
 * @param agent - agent receiving the followup.
 * @param text - message body.
 */
export function send(agent: Agent, text: string): void {
  agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
}
