/**
 * Loader fixture for the approval-adversary composition suite: one scripted
 * LLM adapter serving both the agent's turns and the reviewer's call, plus one
 * tool that resolves a model-supplied justification through `ctx.approval`.
 * @module dsh-approval-adversary/tests/fixtures/reviewed-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Cordis plugin name. */
export const name = 'approval-adversary-fixture'
/** Services this fixture contributes to. */
export const inject = ['llm', 'tools', 'approval']

/** The tool name the scripted model calls. */
export const FIXTURE_TOOL = 'clean_build'

/** What the scripted agent says and how the scripted reviewer answers; the spec sets it before boot. */
export const scenario = {
  /** The justification the agent's tool call carries. */
  justification: 'the user asked to remove stale build output before rebuilding',
  /** The reviewer's complete reply. */
  review: 'VERDICT: ALLOW\nREASON: removing stale output is the step the user asked for',
}

/** Every request the adapter served, agent turns and reviewer calls alike. */
export const requests: GenerateOptions[] = []

/** One scripted assistant text turn. */
function text(body: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: body },
    { type: 'block-end', index: 0, block: { type: 'text', text: body } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

/** One scripted assistant turn calling {@link FIXTURE_TOOL}. */
function toolCall(rawId: string, args: object): StreamChunk[] {
  const id = ToolCallId(rawId)
  const argumentsJson = JSON.stringify(args)
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id, name: FIXTURE_TOOL, argumentsDelta: argumentsJson },
    { type: 'block-end', index: 0, block: { type: 'tool-call', id, name: FIXTURE_TOOL, arguments: argumentsJson } },
    { type: 'usage', usage: { inputTokens: 1, outputTokens: 1 } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]
}

/** Scripted adapter: reviewer calls answer from the scenario; agent turns consume the next turn. */
class ScriptedAdapter extends LlmAdapter {
  private turn = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    requests.push(options)
    const chunks = options.system?.startsWith('You are an adversarial approval reviewer') === true
      ? text(scenario.review)
      : this.turn === 0 ? toolCall('call-1', { justification: scenario.justification }) : text('done')
    if (options.tools !== undefined) this.turn += 1
    for (const chunk of chunks) yield chunk
  }
}

/**
 * Register the fixture adapter and the approval-asking tool.
 * @param ctx - fixture plugin context carrying `llm`, `tools`, and `approval`.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.llm.registerAdapter(['mock'], new ScriptedAdapter()), 'fixture.adapter()')
  ctx.effect(() => ctx.tools.register(defineContentToolFixture({
    name: FIXTURE_TOOL,
    description: 'Remove stale build output, escalating with a justification when needed.',
    parameters: {
      justification: { type: 'string', required: true, description: 'Why the escalation is needed.' },
    },
    async execute(args, exec): Promise<ContentBlock[]> {
      const agent = exec.agent
      // Tool discovery is agent-scoped in this composition, so the carrier is present.
      if (agent === undefined) throw new Error(`${FIXTURE_TOOL} requires a calling Agent`)
      const outcome = await ctx.approval.request({
        agent,
        toolName: FIXTURE_TOOL,
        callId: exec.callId,
        reason: `escalate sandbox to danger-full-access: ${args.justification}`,
      })
      return [{ type: 'text', text: `outcome:${outcome}` }]
    },
  })), 'fixture.tool()')
}
