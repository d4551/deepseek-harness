/**
 * Basic replay-aware compaction backend with checkpoint-aware range selection
 * and a hysteresis watermark below the pressure threshold.
 *
 * @module @deepseek-ai/dsh-compaction-basic
 */

import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { TokenMeasurement, TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
// Type-only: makes the optional sibling service available to `ctx.get()`.
import type { ToolResultPruner } from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import {
  resolveCompactSpec,
  resolveConfig,
  resolveTargetPolicy,
  TargetPressureConfigError,
} from './config.ts'
import {
  assertNoActiveCompaction,
} from './lock.ts'
import {
  selectCompactableRange,
} from './selection.ts'
import type { CompactRangeStrategy } from './selection.ts'
import { settleOne } from './settle.ts'
import { compactSurfaceRegion } from './transaction.ts'
import { runManualCompaction } from './manual.ts'
import type { ManualCompactionDependencies } from './manual.ts'
import { SummaryShrinkError, summarizeWithLlm } from './summarizer.ts'
import type { SummarizationInput, SummaryResult } from './summarizer.ts'
import { conversationTarget, routedTarget } from './target.ts'
import { registerAutomaticCompaction } from './auto.ts'
import type {
  BasicCompactionConfig,
  ResolvedConfig,
} from './types.ts'

export type {
  BasicCompactionConfig,
  CompactionPolicyConfig,
  ModelCompactPolicyConfig,
  ResolvedCompactSpec,
  ResolvedConfig,
  ResolvedRetention,
  ResolvedTargetPolicy,
} from './types.ts'

import {
  compactionRetriesSchema,
  maxOverflowRetriesSchema,
  maxTokensSchema,
  modelPolicySchema,
  retainRatioSchema,
  retainTokensSchema,
  summarizationModelSchema,
  summarizationProviderSchema,
  targetRatioSchema,
  thresholdRatioSchema,
} from './schema.ts'
/** The region transaction's view of this service's dynamically dispatched summarizer. */
type RegionSummarize = (input: SummarizationInput, agent: Agent, signal?: AbortSignal) => Promise<SummaryResult>

/**
 * Dependency-light compaction backend using `ctx.tokenMeter` for pressure,
 * retention, cited source events, and summary-convergence pricing.
 *
 * `summarize()` is the sole subclass customization hook; the replay and durable
 * mutation strategy stays fixed so every pricing decision uses the singleton
 * token meter.
 */
export class BasicCompactionEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions']

  static Config: z<BasicCompactionConfig> = z.object({
    thresholdRatio: thresholdRatioSchema,
    targetRatio: targetRatioSchema,
    retainRatio: retainRatioSchema,
    retainTokens: retainTokensSchema,
    summarizationProvider: summarizationProviderSchema,
    summarizationModel: summarizationModelSchema,
    maxTokens: maxTokensSchema,
    compactionRetries: compactionRetriesSchema,
    maxOverflowRetries: maxOverflowRetriesSchema,
    modelPolicies: z.array(modelPolicySchema),
    auto: z.boolean(),
  })

  /** Resolved and validated compaction configuration. */
  readonly config: ResolvedConfig

  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    if (this.config.auto) registerAutomaticCompaction(ctx, this)
  }

  /**
   * Summarize the replayed conversation region through a direct one-shot
   * `ctx.llm.stream()` call whose prefix reuses the conversation's own system
   * prompt, tools, and messages so the provider's KV cache is not invalidated.
   * Override this sole hook for a template or remote summarizer.
   * @param input - replayed conversation prefix (system, tools, and leading messages) to condense.
   * @param agent - supplies routed-model history, agent option models, and session id.
   * @param signal - optional cancellation forwarded to the LLM service.
   * @returns safe text summary blocks and the exact auxiliary call envelope and output.
   */
  protected async summarize(
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<SummaryResult> {
    const target = conversationTarget(agent)
    const config = target === undefined
      ? this.config
      : resolveTargetPolicy(this.config, target)
    return summarizeWithLlm(this.ctx, config, input, agent, signal)
  }

  /**
   * Compact for replayed step-boundary pressure or one provider-confirmed
   * context overflow. Both triggers price the latest durable routed request
   * envelope; overflow bypasses the normal threshold and retained-tail policy
   * so it can force one maximal balanced head reduction. Pressure passes keep
   * compacting toward the hysteresis watermark below the threshold, skipping
   * one leading checkpoint first and consolidating on later passes.
   * @param agent - agent whose latest durable routed request is measured.
   * @param trigger - normal step-boundary pressure or context-overflow recovery.
   * @param signal - live turn cancellation signal forwarded to summarization.
   * @returns the latest summary compaction result, or `null` when no summary ran.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const target = routedTarget(agent.session)
    if (target === undefined) return null
    const policy = resolveTargetPolicy(this.config, target)
    const meter = this.ctx.tokenMeter
    let measurement = meter.measure(agent.session)

    // Pruning is optional so compaction-basic remains independently composable.
    const prune = this.ctx.get('toolResultPruner')

    if (trigger === 'context-overflow') {
      measurement = this.pruneSurface(prune, agent.session, meter, measurement)
      const plan = selectCompactableRange(agent.session, measurement, 0, {
        strategy: 'consolidate',
      })
      if (plan.kind === 'none') return null
      const result = await this.compactRegion(plan.start, plan.end, agent, signal)
      this.logCompaction(result, 'context overflow recovery', plan.strategy)
      return result
    }

    const context = (await this.ctx.llm.resolveModelInfo(target.provider, target.model, signal)).context
    assertNoActiveCompaction(agent.session, 'automatic pressure compaction')
    const targetKey = `${target.provider}/${target.model}`
    if (context === undefined) {
      throw new TargetPressureConfigError(
        targetKey,
        `compaction-basic: no context capacity for ${targetKey}; `
        + 'configure contextWindow on that model',
      )
    }
    const spec = resolveCompactSpec(policy, context.contextWindow)
    if (measurement.totalTokens < spec.thresholdTokens) return null

    // Once pressure qualifies, land the model-free pass before choosing a
    // summary range, then remeasure through the singleton replay fold.
    if (prune !== undefined) {
      prune.pruneSession(agent.session)
      measurement = meter.measure(agent.session)
    }
    if (measurement.totalTokens < spec.thresholdTokens) return null

    let result: CompactionResult | undefined
    for (let pass = 0; pass <= spec.compactionRetries; pass += 1) {
      const plan = selectCompactableRange(agent.session, measurement, spec.retainTokens, {
        strategy: pass === 0 ? 'auto' : 'consolidate',
      })
      if (plan.kind === 'none') {
        this.ctx.logger.warn(
          `compaction: no compactable range (${plan.reason}); `
          + `${measurement.totalTokens} estimated tokens vs threshold ${spec.thresholdTokens}`,
        )
        break
      }
      const outcome = await settleOne(this.compactRegion(plan.start, plan.end, agent, signal))
      if (outcome.status === 'rejected') {
        const reason = outcome.reason
        if (reason instanceof SummaryShrinkError) {
          if (pass === spec.compactionRetries) throw reason
          this.ctx.logger.info(
            `compaction: summary did not shrink its source span (${plan.strategy}); `
            + 'consolidating on the next pass',
          )
          continue
        }
        throw reason
      }
      result = outcome.value
      this.logCompaction(result, 'step pressure', plan.strategy)
      measurement = meter.measure(agent.session)
      if (measurement.totalTokens < spec.targetTokens) return result
    }

    if (result === undefined) return null
    if (measurement.totalTokens >= spec.thresholdTokens) {
      throw new Error(
        `compaction still above threshold after ${spec.compactionRetries + 1} compaction attempts `
        + `(${measurement.totalTokens} estimated tokens >= threshold ${spec.thresholdTokens})`,
      )
    }
    return result
  }

  /**
   * Compact one inclusive positional range from the agent-owned surface using
   * the effective token meter for all retention and shrink pricing.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session, used by the summarizer.
   * @param signal - optional summarization cancellation signal.
   * @returns the successful durable compaction result.
   */
  override async compactRegion(
    start: number,
    end: number,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    return compactSurfaceRegion(
      this.regionDependencies(),
      agent.session,
      start,
      end,
      agent,
      { owner: 'current-turn', stability: 'whole-surface' },
      signal,
    )
  }

  /**
   * Force one useful idle-session compaction below the pressure threshold, and
   * resolve only after its standalone marker pair is durably checkpointed.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this compaction request.
   * @param sourceCommandId - initiating command identity for presentation correlation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    return runManualCompaction({
      dependencies: this.manualDependencies(),
      agent,
      signal,
      sourceCommandId,
    })
  }

  /** Log one successful replacement with its trigger and span strategy. */
  private logCompaction(
    result: CompactionResult,
    label: string,
    strategy: CompactRangeStrategy,
  ): void {
    this.ctx.logger.info(
      `compaction (${label}, ${strategy}): shadowed ${result.shadowedSeqs.length} surface nodes `
      + `(seqs ${result.shadowedRange.start}-${result.shadowedRange.end}, `
      + `~${result.shadowedTokenCount} tokens)`,
    )
  }

  /** Bind the effective token meter and dynamically dispatched summarizer hook. */
  private regionDependencies(): { meter: TokenMeter; summarize: RegionSummarize } {
    return {
      meter: this.ctx.tokenMeter,
      summarize: (input, owner, abort) => this.summarize(input, owner, abort),
    }
  }

  /** Bind the manual entry point's meter, region transaction, and durability flush. */
  private manualDependencies(): ManualCompactionDependencies {
    return {
      meter: this.ctx.tokenMeter,
      region: this.regionDependencies(),
      flush: async (session) => {
        await this.ctx.sessions.flush(session)
      },
    }
  }

  /**
   * Land the optional model-free prune pass, then return the remeasurement of
   * the resulting surface.
   * @param prune - optional tool-result pruner, absent in pruner-less compositions.
   * @param session - session whose over-budget tool results are rewritten.
   * @param meter - conversation meter used for the remeasurement.
   * @param measurement - measurement superseded by the prune pass.
   * @returns the current measurement after pruning, or the original when the pruner is absent.
   */
  private pruneSurface(
    prune: ToolResultPruner | undefined,
    session: Session,
    meter: TokenMeter,
    measurement: TokenMeasurement,
  ): TokenMeasurement {
    if (prune === undefined) return measurement
    prune.pruneSession(session)
    return meter.measure(session)
  }
}

export default BasicCompactionEngine
