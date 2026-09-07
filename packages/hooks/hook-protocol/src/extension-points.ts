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

/**
 * Consecutive forced continuations a Stop hook may impose on one turn before
 * it is overridden and the turn stops: the cap Claude Code applies, so a hook
 * that blocks unconditionally cannot keep one turn alive forever.
 */
const STOP_HOOK_CONTINUATION_CAP = 8

/**
 * The context each agent's `SessionStart` runs produced and no step has read
 * yet. The agent's next pre-step waits for it and carries it into that
 * request, so the hook's context reaches the first model call instead of the
 * one after it.
 */
const sessionStarts = new WeakMap<Agent, Promise<UserMessage[]>>()

/**
 * Wait for `pending`, or stop waiting the moment `signal` aborts; the caller's
 * own abort check follows, so a cancelled turn never idles on a slow hook.
 * @param pending - the settlement to wait for.
 * @param signal - the waiting operation's cancellation.
 * @returns the settled value, or `undefined` when the signal aborted first.
 */
async function untilAborted<T>(pending: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
  if (signal.aborted) return undefined
  const aborted = Promise.withResolvers<undefined>()
  const onAbort = (): void => { aborted.resolve(undefined) }
  signal.addEventListener('abort', onAbort, { once: true })
  return Promise.race([pending, aborted.promise]).finally(() => { signal.removeEventListener('abort', onAbort) })
}

/** Prepend one context without flattening source fields or other downstream metadata. */
function prependContext(ours: UserMessage, theirs: UserMessage[] | undefined): UserMessage[] {
  return [ours, ...theirs ?? []]
}

/**
 * The text a halting hook leaves behind: its `stopReason`, else the blocking
 * reason it paired the halt with, else the point's own wording.
 * @param merged - the folded outcome whose `stop` is set.
 * @param point - the hook point that halted.
 * @returns the reason recorded on the turn and shown where the dialect shows it.
 */
function stopReasonOf(merged: MergedHookOutcome, point: string): string {
  return merged.stopReason ?? merged.reason ?? `${point} hook returned continue: false`
}

/**
 * End the turn on a halting hook: the cancel cause records the reason on the
 * turn's end and clears pending work, so the agent settles idle instead of
 * picking up the next queued item. Where the dialect shows stop reasons to
 * the model, the reason is also queued, without waking the agent, for its
 * next request.
 * @param hooks - the shared execution surface.
 * @param agent - the agent whose turn halts.
 * @param point - the hook point that halted.
 * @param merged - the folded outcome whose `stop` is set.
 */
function haltTurn(hooks: HookBridge, agent: Agent, point: string, merged: MergedHookOutcome): void {
  agent.cancel({ kind: 'hook', reason: stopReasonOf(merged, point) })
  if (!hooks.stops.stopReasonToModel || merged.stopReason === undefined) return
  agent.inject(createUserMessage({ content: [{ type: 'text', text: merged.stopReason }], source: hooks.source }))
}

/**
 * Warn that a hook returned a field the dialect does not apply on `point`.
 * @param ctx - the dialect plugin's context, whose logger carries the warning.
 * @param hooks - the shared execution surface, named in the warning.
 * @param point - the hook point that received the field.
 * @param field - the returned field, as the hook spelled it.
 */
function warnUnsupported(ctx: Context, hooks: HookBridge, point: string, field: string): void {
  ctx.logger.warn(`${hooks.plugin}: ${point} hook returned ${field}, which this point does not apply`)
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
 * Register `SessionStart` on `agent/session-start`. The point is emit-shaped,
 * so the run is detached, but its context is not left to arrive whenever the
 * hook resolves: the agent's next pre-step waits for the run and carries the
 * context into that request, so a slow hook delays the first model call
 * instead of missing it.
 * @param ctx - the dialect plugin's context.
 * @param hooks - the shared execution surface.
 * @param options - the dialect's payload builder and stdout-context rule.
 */
export function registerSessionStartHook(ctx: Context, hooks: HookBridge, options: SessionStartHookOptions): void {
  ctx.on('agent/session-start', ({ agent, source }) => {
    const context = (async (): Promise<UserMessage | undefined> => {
      const [run] = await Promise.allSettled([hooks.run('SessionStart', source, options.payload(agent, source), {
        agent,
        signal: hooks.detachedSignal,
        plainStdoutAsContext: options.plainStdoutAsContext,
      })])
      if (run.status === 'rejected') {
        hooks.warnFailure('SessionStart', run.reason)
        return undefined
      }
      return hooks.context(run.value)
    })()
    // Two dialects may both run at one start; the step reads every dialect's
    // context in the order the runs were announced.
    const earlier = sessionStarts.get(agent) ?? Promise.resolve([])
    const combined = Promise.all([earlier, context]).then(([before, ours]) => ours === undefined ? before : [...before, ours])
    sessionStarts.set(agent, combined)
    hooks.detach(combined)
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
 * Register `UserPromptSubmit` on `agent/pre-step`. A halting hook
 * (`continue: false`) refuses the prompt and ends the turn with its reason; a
 * denying hook rejects the step; context alone is not a veto, so the chain
 * still delegates and the hooks' context rides on a downstream enter decision.
 * @param ctx - the dialect plugin's context.
 * @param hooks - the shared execution surface.
 * @param options - the dialect's payload builder and stdout-context rule.
 */
export function registerPreStepHook(ctx: Context, hooks: HookBridge, options: PreStepHookOptions): void {
  ctx.on('agent/pre-step', async ({ agent, messages, turn, signal }, next): Promise<PreStepDecision> => {
    // Session-start context waits here rather than riding the inbox: this
    // step's batch is already claimed, so a message queued now would reach the
    // request after this one. A wait cut short by cancellation leaves the
    // context queued for the next step.
    const pendingStart = sessionStarts.get(agent)
    const started = pendingStart === undefined ? undefined : await untilAborted(pendingStart, signal)
    const withContext = (decision: PreStepDecision, after: UserMessage[]): PreStepDecision => {
      if (decision.kind !== 'enter') return decision
      if (started !== undefined && sessionStarts.get(agent) === pendingStart) sessionStarts.delete(agent)
      const before = started ?? []
      if (before.length === 0 && after.length === 0) return decision
      return { ...decision, messages: [...before, ...decision.messages, ...after] }
    }
    if (messages.length === 0) return withContext(await next(), [])
    const prompt = blocksToText(messages.flatMap(message => message.content))
    const merged = await hooks.run('UserPromptSubmit', '', options.payload({ agent, turn, prompt }), {
      agent, turn, signal, plainStdoutAsContext: options.plainStdoutAsContext,
    })
    if (merged.stop) {
      haltTurn(hooks, agent, 'UserPromptSubmit', merged)
      return { kind: 'reject' }
    }
    if (merged.decision === 'deny') return { kind: 'reject' }
    const ours = hooks.context(merged, 'UserPromptSubmit')
    return withContext(await next(), ours === undefined ? [] : [ours])
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
 * Register `PreToolUse` on `tools/pre-execute`. A halting hook
 * (`continue: false`) denies the call and ends the turn where the dialect
 * halts here, and is warned about where it does not; a denying hook blocks the
 * call with its reason; anything else delegates.
 * @param ctx - the dialect plugin's context.
 * @param hooks - the shared execution surface.
 * @param options - the dialect's payload builder and honored decisions.
 */
export function registerPreToolHook(ctx: Context, hooks: HookBridge, options: PreToolHookOptions): void {
  ctx.on('tools/pre-execute', async (exec, next): Promise<PreToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await hooks.run('PreToolUse', exec.name, options.payload(exec), {
      ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal,
    })
    if (merged.stop && hooks.stops.preTool === 'halt') {
      // The denial text is what the model reads, so the reason travels there
      // once instead of being queued a second time as context.
      const reason = stopReasonOf(merged, 'PreToolUse')
      if (exec.agent !== undefined) exec.agent.cancel({ kind: 'hook', reason })
      return { kind: 'deny', reason }
    }
    if (merged.stop) warnUnsupported(ctx, hooks, 'PreToolUse', 'continue: false')
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
 * Register `PostToolUse` on `tools/post-execute`. A halting hook
 * (`continue: false`) replaces the result with its stop text where the dialect
 * does that, and is warned about where the dialect reads no `continue` here; a
 * denying hook blocks the result with its reason; otherwise the chain delegates
 * and the hooks' context is prepended to whatever decision comes back.
 * @param ctx - the dialect plugin's context.
 * @param hooks - the shared execution surface.
 * @param options - the dialect's payload builder.
 */
export function registerPostToolHook(ctx: Context, hooks: HookBridge, options: PostToolHookOptions): void {
  ctx.on('tools/post-execute', async (exec, result, next): Promise<PostToolDecision> => {
    const turn = lastTurn(exec.agent)
    const merged = await hooks.run('PostToolUse', exec.name, options.payload(exec, blocksToText(result.content)), {
      ...exec.agent ? { agent: exec.agent } : {}, turn, signal: exec.signal,
    })
    const context = hooks.context(merged, 'PostToolUse')
    if (merged.stop && hooks.stops.postTool === 'replace-result') {
      return {
        kind: 'block',
        feedback: [{ type: 'text', text: stopReasonOf(merged, 'PostToolUse') }],
        ...context ? { additionalContexts: [context] } : {},
      }
    }
    if (merged.stop) warnUnsupported(ctx, hooks, 'PostToolUse', 'continue: false')
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
   * @param stopHookActive - whether a Stop hook already forced this turn to continue; both dialects name it `stop_hook_active`.
   * @returns the dialect payload.
   */
  payload: (agent: Agent, stopHookActive: boolean) => unknown
}

/**
 * Register `Stop` on `agent/turn-stopping`. A blocking hook steers at the
 * stopping boundary, which makes the machine observe pending input and run
 * another step; a block with no reason still forces continuation, and the
 * hooks' context rides along so the next request sees it. A halting hook
 * (`continue: false`) outranks the block: the turn stops, and nothing is
 * queued, because any pending message at this boundary would itself force
 * another step. Each forced continuation is counted per turn: later runs in
 * that turn see `stopHookActive`, and past
 * {@link STOP_HOOK_CONTINUATION_CAP} the block is overridden with a warning.
 * @param ctx - the dialect plugin's context.
 * @param hooks - the shared execution surface.
 * @param options - the dialect's payload builder.
 */
// TODO(stop-loop-guard): cap consecutive forced continuations; hooks must self-limit meanwhile.
export function registerTurnStoppingHook(ctx: Context, hooks: HookBridge, options: TurnStoppingHookOptions): void {
  // Forced continuations per agent within one turn: the flag tells a Stop hook
  // it already continued this turn, and past the cap the hook is overridden.
  const continued = new WeakMap<Agent, { turn: number; count: number }>()
  ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
    const previous = continued.get(agent)
    const count = previous !== undefined && previous.turn === turn ? previous.count : 0
    const merged = await hooks.run('Stop', '', options.payload(agent, count > 0), { agent, turn, signal })
    if (merged.stop || merged.decision !== 'deny') return
    if (count >= STOP_HOOK_CONTINUATION_CAP) {
      ctx.logger.warn(`${hooks.plugin}: Stop hook blocked ${String(count)} consecutive times in turn ${String(turn)}; the turn stops`)
      return
    }
    continued.set(agent, { turn, count: count + 1 })
    const context = hooks.context(merged, 'Stop')
    if (context) agent.inject(context)
    const text = merged.reason ?? 'continue: blocked by Stop hook'
    agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: hooks.source }))
  })
}
