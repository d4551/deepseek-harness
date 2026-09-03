/**
 * The interception extension points both hook bridges map onto, one registrar
 * per point. Each registrar owns the shared decision folding — deny wins, a
 * context-only outcome delegates instead of vetoing, and a downstream decision
 * still carries the hooks' context — while the dialect supplies only its stdin
 * payload and the capabilities it honors. Points a single dialect owns
 * (Claude Code's subagent pair) stay in that bridge and drive {@link HookBridge}
 * directly.
 * @module @deepseek-ai/dsh-hook-protocol/extension-points
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import type { PostToolDecision, PreToolDecision, ToolExecution } from '@deepseek-ai/dsh-tools'
import type { HookBridge } from './bridge.ts'
import type { MergedHookOutcome } from './merge.ts'
import { blocksToText, lastTurn } from './payload.ts'

/** Prepend one context without flattening source fields or other downstream metadata. */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/**
 * Inject a merged outcome's context into an agent, when both are present.
 * Detached points deliver context this way because no extension point awaits
 * their decision.
 * @param bridge - the bridge whose plugin source stamps the message.
 * @param agent - the agent to inject into; absent when the run had no live agent.
 * @param merged - the folded outcome of the detached run.
 */
export function injectHookContext(bridge: HookBridge, agent: Agent | undefined, merged: MergedHookOutcome): void {
  const context = bridge.context(merged)
  if (context && agent) agent.inject(context)
}

/** How a dialect fills its `SessionStart` payload. */
export interface SessionStartHookOptions {
  /**
   * Build the stdin payload for one session start.
   * @param agent - the starting agent.
   * @param source - what started the session; also the matcher subject.
   * @returns the dialect payload.
   */
  payload: (agent: Agent, source: string) => unknown
  /** Whether clean plain stdout becomes context on this point. */
  plainStdoutAsContext: boolean
}

/**
 * Register `SessionStart` on `agent/session-start`. The point is emit-shaped, so
 * the run is detached and its context arrives whenever the hook resolves — a
 * slow hook may miss the first model request.
 * @param ctx - the bridge plugin's context.
 * @param bridge - the shared execution surface.
 * @param options - the dialect's payload builder and stdout-context rule.
 */
// TODO(session-start-gating): add a startup gate before promising first-turn delivery.
export function registerSessionStartHook(ctx: Context, bridge: HookBridge, options: SessionStartHookOptions): void {
  ctx.on('agent/session-start', ({ agent, source }) => {
    bridge.detach(bridge.run('SessionStart', source, options.payload(agent, source), {
      agent,
      signal: bridge.detachedSignal,
      plainStdoutAsContext: options.plainStdoutAsContext,
    })
      .then((merged) => { injectHookContext(bridge, agent, merged) })
      .catch((error: unknown) => { bridge.warnFailure('SessionStart', error) }))
  })
}

/** How a dialect fills its `UserPromptSubmit` payload. */
export interface PreStepHookOptions {
  /**
   * Build the stdin payload for one submitted prompt.
   * @param input - the submitting agent, its open turn, and the flattened prompt text.
   * @returns the dialect payload.
   */
  payload: (input: { agent: Agent; turn: number; prompt: string }) => unknown
  /** Whether clean plain stdout becomes context on this point. */
  plainStdoutAsContext: boolean
}

/**
 * Register `UserPromptSubmit` on `agent/pre-step`. A denying hook rejects the
 * step; context alone is not a veto, so the chain still delegates and the
 * hooks' context rides on a downstream enter decision.
 * @param ctx - the bridge plugin's context.
 * @param bridge - the shared execution surface.
 * @param options - the dialect's payload builder and stdout-context rule.
 */
export function registerPreStepHook(ctx: Context, bridge: HookBridge, options: PreStepHookOptions): void {
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    if (messages.length === 0) return next()
    const prompt = blocksToText(messages.flatMap(message => message.content))
    const merged = await bridge.run('UserPromptSubmit', '', options.payload({ agent, turn, prompt }), {
      agent, turn, signal, plainStdoutAsContext: options.plainStdoutAsContext,
    })
    if (merged.decision === 'deny') return { kind: 'reject' }
    const downstream = await next()
    const ours = bridge.context(merged)
    if (!ours || downstream.kind !== 'enter') return downstream
    return {
      ...downstream,
      messages: [...downstream.messages, ours],
    }
  })
}

/** How a dialect fills its `PreToolUse` payload and which decisions it honors. */
export interface PreToolHookOptions {
  /**
   * Build the stdin payload for one pending tool call.
   * @param exec - the execution about to run; its `name` is the matcher subject.
   * @returns the dialect payload.
   */
  payload: (exec: ToolExecution) => unknown
  /**
   * Whether an `ask` outcome routes to approval. Claude Code's permission
   * decisions include `ask`; Codex honors blocking decisions only.
   */
  honorAsk: boolean
}

/**
 * Register `PreToolUse` on `tools/pre-execute`. A denying hook blocks the call
 * with its reason; anything else delegates.
 * @param ctx - the bridge plugin's context.
 * @param bridge - the shared execution surface.
 * @param options - the dialect's payload builder and honored decisions.
 */
export function registerPreToolHook(ctx: Context, bridge: HookBridge, options: PreToolHookOptions): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await bridge.run('PreToolUse', exec.name, options.payload(exec), {
      ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal,
    })
    if (merged.decision === 'deny') return { kind: 'deny', reason: merged.reason ?? 'blocked by PreToolUse hook' }
    if (options.honorAsk && merged.decision === 'ask') {
      return { kind: 'ask', ...merged.reason !== undefined ? { reason: merged.reason } : {} }
    }
    return next()
  })
}

/** How a dialect fills its `PostToolUse` payload. */
export interface PostToolHookOptions {
  /**
   * Build the stdin payload for one completed tool call.
   * @param exec - the execution that ran; its `name` is the matcher subject.
   * @param response - the result's flattened text.
   * @returns the dialect payload.
   */
  payload: (exec: ToolExecution, response: string) => unknown
}

/**
 * Register `PostToolUse` on `tools/post-execute`. A denying hook blocks the
 * result with its reason; otherwise the chain delegates and the hooks' context
 * is prepended to whatever decision comes back.
 * @param ctx - the bridge plugin's context.
 * @param bridge - the shared execution surface.
 * @param options - the dialect's payload builder.
 */
export function registerPostToolHook(ctx: Context, bridge: HookBridge, options: PostToolHookOptions): void {
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await bridge.run('PostToolUse', exec.name, options.payload(exec, blocksToText(result.content)), {
      ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal,
    })
    const context = bridge.context(merged)
    if (merged.decision === 'deny') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: merged.reason ?? 'blocked by PostToolUse hook' }],
        ...context ? { additionalContexts: [context] } : {},
      }
    }
    const downstream = await next()
    if (!context) return downstream
    return { ...downstream, additionalContexts: prependContext(context, downstream.additionalContexts) }
  })
}

/** How a dialect fills its `Stop` payload. */
export interface TurnStoppingHookOptions {
  /**
   * Build the stdin payload for one stopping turn.
   * @param agent - the agent whose turn is stopping.
   * @returns the dialect payload.
   */
  payload: (agent: Agent) => unknown
}

/**
 * Register `Stop` on `agent/turn-stopping`. A blocking hook steers at the
 * stopping boundary, which makes the machine observe pending input and run
 * another step; a block with no reason still forces continuation.
 * @param ctx - the bridge plugin's context.
 * @param bridge - the shared execution surface.
 * @param options - the dialect's payload builder.
 */
// TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile.
export function registerTurnStoppingHook(ctx: Context, bridge: HookBridge, options: TurnStoppingHookOptions): void {
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const merged = await bridge.run('Stop', '', options.payload(agent), { agent, turn, signal })
    if (merged.decision === 'deny') {
      const text = merged.reason ?? 'continue: blocked by Stop hook'
      agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: bridge.source }))
    }
  })
}
