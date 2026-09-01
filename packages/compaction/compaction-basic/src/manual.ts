/**
 * Manual idle-session compaction: reserve maintenance admission, select one
 * useful span below automatic pressure, and run the standalone bracket
 * transaction with a durability checkpoint.
 *
 * @module @deepseek-ai/dsh-compaction-basic/manual
 */

import { ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertNoActiveCompaction } from './lock.ts'
import { selectCompactableRange } from './selection.ts'
import { settleCall, settleOne } from './settle.ts'
import { captureFailure, compactSurfaceRegion } from './transaction.ts'
import type { RegionDependencies } from './transaction.ts'

/** Collaborators the manual entry point binds from the owning engine. */
export interface ManualCompactionDependencies {
  readonly meter: TokenMeter
  readonly region: RegionDependencies
  flush(session: Session): Promise<void>
}

/** One manual compaction request from the engine entry point. */
interface ManualRequest {
  readonly dependencies: ManualCompactionDependencies
  readonly agent: Agent
  readonly signal: AbortSignal
  readonly sourceCommandId: CommandId | undefined
}

/** A manual request plus the maintenance-owned cancellation signal. */
interface ManualTaskRequest extends ManualRequest {
  readonly agentSignal: AbortSignal
}

/** Manual maintenance outcome: the committed result, or a captured failure. */
type ManualOutcome =
  | { readonly ok: true; readonly value: CompactionResult | null }
  | { readonly ok: false; readonly error: Error }

/**
 * Reserve idle admission and run one manual compaction to its durable outcome.
 * The caller performs the synchronous pre-abort check so a pre-aborted signal
 * wins before any reservation.
 * @param request - dependencies, target agent, cancellation, and command identity.
 * @returns the committed result, or `null` when no safe useful range exists.
 */
export async function runManualCompaction(
  request: ManualRequest,
): Promise<CompactionResult | null> {
  const { dependencies, agent, signal, sourceCommandId } = request
  const outcome = await settleCall(() => agent.runMaintenance(
    agentSignal => runManualTask({ dependencies, agent, agentSignal, signal, sourceCommandId }),
  ))
  if (outcome.status === 'fulfilled') {
    const manual = outcome.value
    if (manual.ok) return manual.value
    throw manual.error
  }
  throw new ManualCompactionError(
    'busy',
    'manual compaction requires an idle agent with no waking queued work',
    { cause: captureFailure(outcome.reason) },
  )
}

/**
 * Run the maintenance phase inside a promise boundary so every failure
 * settles into a manual outcome instead of rejecting the admission promise.
 */
async function runManualTask(request: ManualTaskRequest): Promise<ManualOutcome> {
  const outcome = await settleOne(runManualPhase(request))
  if (outcome.status === 'fulfilled') return { ok: true, value: outcome.value }
  return { ok: false, error: captureFailure(outcome.reason) }
}

/** Select and commit one idle-session span; cancellation keeps precedence. */
async function runManualPhase(request: ManualTaskRequest): Promise<CompactionResult | null> {
  const { dependencies, agent, agentSignal, signal, sourceCommandId } = request
  const operationSignal = AbortSignal.any([agentSignal, signal])
  operationSignal.throwIfAborted()
  assertNoActiveCompaction(agent.session, 'manual compaction')
  const plan = selectCompactableRange(
    agent.session,
    dependencies.meter.measure(agent.session),
    0,
  )
  if (plan.kind === 'none') return null
  const outcome = await settleOne(compactSurfaceRegion(
    dependencies.region,
    agent.session,
    plan.start,
    plan.end,
    agent,
    {
      owner: null,
      stability: 'selected-span',
      ...sourceCommandId === undefined ? {} : { sourceCommandId },
      flush: async () => {
        await dependencies.flush(agent.session)
      },
    },
    operationSignal,
  ))
  if (outcome.status === 'fulfilled') return outcome.value
  const error = outcome.reason
  if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
    throw new ManualCompactionError(
      'cancelled',
      'manual compaction was cancelled',
      { cause: error },
    )
  }
  operationSignal.throwIfAborted()
  throw error
}
