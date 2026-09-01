/**
 * Automatic compaction listeners: between-step pressure before request
 * derivation, and provider-confirmed context-overflow recovery after a failed
 * request. Registered only when `auto` is enabled.
 *
 * @module @deepseek-ai/dsh-compaction-basic/auto
 */

import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision, RequestErrorAction } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import { TargetPressureConfigError, resolveTargetPolicy } from './config.ts'
import { settleOne } from './settle.ts'
import { routedTarget } from './target.ts'
import type { BasicCompactionEngine } from './index.ts'

/**
 * Read the abort state after an await. A guard before the await narrows
 * `signal.aborted` to `false` for the rest of the handler, while abort can
 * still land while the awaited work runs.
 * @param signal - the cancellation signal the handler received.
 * @returns whether the signal has aborted by now.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/**
 * Register automatic between-step pressure and model-request overflow
 * recovery on the owning engine's context. `compactIfNeeded` stays dynamically
 * dispatched so subclass overrides are honored at event time.
 * @param ctx - owning engine's context; receives the listeners.
 * @param engine - owning backend whose policy and entry point the listeners drive.
 */
export function registerAutomaticCompaction(
  ctx: Context,
  engine: BasicCompactionEngine,
): void {
  const warnedPressureConfigTargets = new Set<string>()
  const overflowRetries = new WeakMap<Agent, number>()
  const overflowAgents = new WeakMap<Session, Agent>()

  ctx.on('agent/pre-step', async (
    { agent, signal },
    next,
  ): Promise<PreStepDecision> => {
    if (signal.aborted) return next()
    const outcome = await settleOne(engine.compactIfNeeded(agent, 'pressure', signal))
    if (outcome.status === 'fulfilled') return next()
    const error = outcome.reason
    if (error instanceof TargetPressureConfigError) {
      if (warnedPressureConfigTargets.has(error.targetKey)) return next()
      warnedPressureConfigTargets.add(error.targetKey)
    }
    const message = error instanceof Error ? error.message : String(error)
    ctx.logger.warn(`step compaction failed: ${message}; continuing the turn`)
    return next()
  })

  ctx.on('agent/status', ({ agent, status }) => {
    if (status === 'idle') overflowRetries.delete(agent)
  })

  // A successful response starts a fresh overflow-recovery sequence even
  // when tool calls continue the same turn into another request.
  ctx.on('session/event', (session, event) => {
    if (event.type !== 'assistant/message') return
    const agent = overflowAgents.get(session)
    if (agent !== undefined) overflowRetries.delete(agent)
  })

  ctx.on('agent/request-error', async (
    { agent, failure, signal },
    next,
  ): Promise<RequestErrorAction> => {
    if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
    overflowAgents.set(agent.session, agent)
    const route = routedTarget(agent.session)
    if (route === undefined) return next()
    const policy = resolveTargetPolicy(engine.config, route)
    const retries = overflowRetries.get(agent) ?? 0
    if (retries >= policy.maxOverflowRetries) return next()

    const generation = agent.session.surface.replaceGeneration
    const outcome = await settleOne(
      engine.compactIfNeeded(agent, 'context-overflow', signal),
    )

    if (outcome.status === 'rejected') {
      const error = outcome.reason
      const message = error instanceof Error ? error.message : String(error)
      // A model-free prune can land before later summary work fails. That
      // durable reduction is sufficient retry proof; do not discard it just
      // because the optional second phase threw. Cancellation still wins.
      if (!isAborted(signal) && agent.session.surface.replaceGeneration > generation) {
        ctx.logger.warn(
          `context-overflow compaction failed after durable surface progress: ${message}; `
          + 'retrying from the replacement surface',
        )
        overflowRetries.set(agent, retries + 1)
        return { kind: 'retry' }
      }
      ctx.logger.warn(
        `context-overflow compaction failed: ${message}; ${isAborted(signal)
          ? 'cancellation prevents retry'
          : 'preserving the original request error'}`,
      )
      return next()
    }
    if (isAborted(signal)
      || agent.session.surface.replaceGeneration <= generation) return next()
    overflowRetries.set(agent, retries + 1)
    return { kind: 'retry' }
  })
}
