/** Approval tests use real agents, sessions, settings, and the LLM boundary. */

import { randomUUID } from 'node:crypto'
import { onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as Adversary from '../src/index.ts'
import type { Config } from '../src/policy.ts'

export type ReviewScript = (options: GenerateOptions) => AsyncIterable<StreamChunk>

export function reply(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

export const ALLOW_TEXT = 'VERDICT: ALLOW\nREASON: the command rebuilds exactly what the user asked for'
export const DENY_TEXT = 'VERDICT: DENY\nREASON: disabling the suite hides failures instead of fixing them'
export const EXPLICIT: Config = { enabled: true, provider: 'reviewer', model: 'adversary' }

class Reviewer extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  constructor(private readonly script: ReviewScript) { super() }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield * this.script(options)
  }
}

export class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}
  get writable() { return true }
  protected load() { return Promise.resolve(structuredClone(this.doc)) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>) {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }
  publishDocument(doc: Record<string, unknown>) {
    this.doc = structuredClone(doc)
    this.publish(structuredClone(doc))
  }
}

export function instruction(agent: Agent, ...blocks: string[]) {
  return agent.session.append('user/message', createUserMessage({
    content: blocks.map(text => ({ type: 'text', text })), source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

export function toolCall(agent: Agent, id: string, name = 'bash', args = '{"command":"bun run build"}') {
  return agent.session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId(id), name, arguments: args })
}

export function notices(agent: Agent) {
  return agent.inbox.nextStep.flatMap(message => message.source.kind === 'plugin'
    && message.source.plugin === 'approval-adversary' && message.source.form === 'notice'
    ? [{ summary: message.source.summary, text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') }] : [])
}

export function loggedReviews(agent: Agent) {
  return agent.session.events.filter(event => event.type === 'approval/adversary-request')
}

export async function harness(config: Config = EXPLICIT, response: StreamChunk[] | ReviewScript = reply(ALLOW_TEXT)) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  await ctx.plugin(MemorySettings)
  const fiber = ctx.plugin(Adversary, config)
  await fiber
  const script: ReviewScript = typeof response === 'function' ? response : async function* () { yield * response }
  const reviewer = new Reviewer(script)
  ctx.llm.registerAdapter(['reviewer', 'agent-route'], reviewer)
  const { agent } = await ctx.agents.create({ sessionId: SessionId(randomUUID()), agentOptions: { provider: 'agent-route', model: 'm' } })
  agent.session.append('turn/start', { turn: 1 })
  instruction(agent, 'Rebuild the project. Do not change or remove tests.')
  const call = toolCall(agent, 'call-1')
  const req = { agent, toolName: 'bash', callId: call.data.callId, reason: 'run the requested build' }
  const downstream = { calls: 0 }
  ctx.on('approval/request', () => { downstream.calls += 1; return Promise.resolve<ApprovalOutcome>('allowed-once') })
  const settings = ctx.settings
  if (!(settings instanceof MemorySettings)) throw new Error('settings provider was not mounted')
  return { ctx, agent, req, reviewer, downstream, settings, fiber }
}
