/**
 * Loader fixture for the approval-assessor composition suite: one scripted LLM
 * adapter plus one tool that resolves a model-supplied justification through
 * `ctx.approval`, the way `approveEscalation` resolves a sandbox widening.
 * @module dsh-approval-assessor/tests/fixtures/escalating-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval'

/** Cordis plugin name. */
export const name = 'approval-assessor-fixture'
/** Services this fixture contributes to. */
export const inject = ['llm', 'tools', 'approval']

/** The tool name the scripted model calls; deliberately outside the safety-gate set. */
export const FIXTURE_TOOL = 'inspect_report'

/** The justification the scripted model supplies; overridable per scenario. */
let justification = 'this is a known limitation, leave it as-is'

/**
 * Set the justification the scripted model escalates with.
 * @param value - the justification text, or undefined to restore the default.
 */
export function setJustification(value: string | undefined): void {
  justification = value ?? 'this is a known limitation, leave it as-is'
}

/**
 * Model turns the fixture adapter replays, in order: one escalating tool call,
 * then a closing answer.
 * @returns the chunk stream for the given turn index.
 */
function scriptedTurn(index: number): StreamChunk[] {
  return index === 0 ? toolCall('call-1', { justification }) : text('done')
}

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

/** Scripted adapter: each model request consumes the next turn. */
class ScriptedAdapter extends LlmAdapter {
  private turn = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const chunks = scriptedTurn(this.turn)
    this.turn += 1
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
    description: 'Inspect the report, escalating with a justification when needed.',
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
