/**
 * The shared log-recorded compaction transaction for automatic open-turn and
 * manual idle-session compaction: bracket-first sequencing, whole-span or
 * selected-span stability, and the single replacement commit.
 *
 * The asynchronous phase runs inside one promise boundary, so any synchronous
 * or asynchronous failure surfaces as a rejection of that phase rather than an
 * escape from this module; the caller reads the settled result and makes
 * exactly one durable `compaction/end` attempt before rethrowing.
 *
 * @module @deepseek-ai/dsh-compaction-basic/transaction
 */

import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import {
  CompactionId,
  ManualCompactionError,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { TokenMeter } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { assertCompactionInactive, inspectCompactionEntryState } from './lock.ts'
import {
  SurfaceChangedError,
  assertSelectedSpanStable,
  assertWholeSurfaceUnchanged,
  prepareCompaction,
  validateSurfaceRegion,
} from './selection.ts'
import type { SurfaceSelection } from './selection.ts'
import { settleCall, settleOne } from './settle.ts'
import { summarizeCompaction } from './summarizer.ts'
import type { SummarizationInput, SummaryResult, SummarizedCompaction } from './summarizer.ts'

/** Transaction collaborators: the conversation meter and the summarize hook. */
export interface RegionDependencies {
  readonly meter: TokenMeter
  readonly summarize: (
    this: void,
    input: SummarizationInput,
    agent: Agent,
    signal?: AbortSignal,
  ) => Promise<SummaryResult>
}

/** Bracket and durability knobs distinguishing automatic from manual entry. */
export interface CompactionTransactionOptions {
  /** `current-turn` derives a numbered owner; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** Surface relationship that must survive asynchronous summarization. */
  readonly stability: 'whole-surface' | 'selected-span'
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
  /** Manual command that initiated this transaction, when present. */
  readonly sourceCommandId?: CommandId
}

/** Failure captured after `compaction/start` has committed. */
interface TransactionFailure {
  readonly error: Error
  readonly stage: 'summary' | 'commit'
}

/** Stage progression shared between the phase runner and the close logic. */
interface PhaseProgress {
  stage: 'summary' | 'commit'
}

/** The lifecycle fields every bracket event of one transaction carries. */
interface BracketLifecycle {
  readonly compactionId: ReturnType<typeof CompactionId>
  readonly sourceCommandId?: CommandId
  readonly turn: number | null
}

/**
 * Run the single compaction transaction over one selected positional span.
 * Selection and validation are read-only. Idle/log validation and
 * `compaction/start` are synchronously adjacent, so the durable opening marker
 * is the compaction lock before summarization yields. Every later failure
 * makes exactly one `compaction/end` attempt; a failed close deliberately
 * leaves the unmatched start detectable.
 * @param dependencies - conversation meter and dynamically dispatched summarizer hook.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq.
 * @param end - inclusive last surface-node seq.
 * @param agent - agent used by the summarizer.
 * @param options - bracket owner, stability rule, and optional durability checkpoint.
 * @param signal - optional summarization cancellation signal.
 * @returns the successful durable compaction result.
 */
export async function compactSurfaceRegion(
  dependencies: RegionDependencies,
  session: Session,
  start: number,
  end: number,
  agent: Agent,
  options: CompactionTransactionOptions,
  signal?: AbortSignal,
): Promise<CompactionResult> {
  if (options.owner === null) signal?.throwIfAborted()
  const selection = validateSurfaceRegion(session, start, end)
  const entryState = inspectCompactionEntryState(session.events)
  assertCompactionInactive(
    entryState.unmatchedCompactionStart,
    entryState.latestEndSeedSeq,
    'compaction',
  )

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError('busy', 'manual compaction: the session already has an open turn')
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error('compactRegion: no open turn — automatic compaction events must be enclosed in a turn')
    }
    owner = entryState.openTurn
  }

  const lifecycle: BracketLifecycle = {
    compactionId: CompactionId(randomUUID()),
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)
  const progress: PhaseProgress = { stage: 'summary' }

  // The async runner is the containment boundary: every prepare, summarize,
  // stability, commit, and close failure inside it settles as a rejection
  // instead of escaping this transaction unrecorded.
  const phase = await settleOne(runCompactionPhase(
    dependencies,
    session,
    startEvent,
    selection,
    agent,
    lifecycle,
    options.sourceCommandId,
    options.stability,
    options.owner,
    signal,
    progress,
  ))

  if (phase.status === 'fulfilled') {
    if (options.flush !== undefined) {
      const flushFailure = await runDurabilityFlush(options.flush)
      if (flushFailure !== undefined) {
        throw new ManualCompactionError(
          'persistence',
          'manual compaction durability checkpoint failed',
          { cause: flushFailure },
        )
      }
    }
    reassertManualSignal(options.owner, signal)
    return phase.value
  }

  const closedFailure = await closeFailedPhase(session, lifecycle, phase.reason, progress.stage)
  if (closedFailure.closed && options.flush !== undefined) {
    await runDurabilityFlush(options.flush)
  }
  reassertManualSignal(options.owner, signal)
  if (options.owner === null) {
    throwManualFailure(closedFailure.failure)
  }
  throw closedFailure.failure.error
}

/**
 * Reassert cancellation authority at one transaction boundary for manual
 * entry; automatic entry carries no own-signal authority to reassert.
 */
function reassertManualSignal(
  owner: CompactionTransactionOptions['owner'],
  signal: AbortSignal | undefined,
): void {
  if (owner === null) signal?.throwIfAborted()
}

/** Classify one closed manual attempt without weakening cancellation precedence. */
function throwManualFailure(failure: TransactionFailure): never {
  if (failure.stage === 'commit') {
    throw new ManualCompactionError(
      'commit',
      'manual compaction did not commit cleanly',
      { cause: failure.error },
    )
  }
  if (failure.error instanceof SurfaceChangedError) {
    throw new ManualCompactionError(
      'changed',
      'the compacted history changed during manual compaction',
      { cause: failure.error },
    )
  }
  throw new ManualCompactionError(
    'summary',
    'manual compaction could not produce a smaller summary',
    { cause: failure.error },
  )
}

/**
 * Run the post-start phase inside the transaction's promise boundary: prepare
 * the priced snapshot, summarize, revalidate stability, commit the replacement
 * body, and close the bracket. Any throw settles as a rejection of this
 * function's promise and is handled by the caller's close logic.
 */
async function runCompactionPhase(
  dependencies: RegionDependencies,
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  selection: SurfaceSelection,
  agent: Agent,
  lifecycle: BracketLifecycle,
  sourceCommandId: CommandId | undefined,
  stability: CompactionTransactionOptions['stability'],
  owner: CompactionTransactionOptions['owner'],
  signal: AbortSignal | undefined,
  progress: PhaseProgress,
): Promise<CompactionResult> {
  const prepared = prepareCompaction(dependencies.meter, session, selection)
  const summarized = await summarizeCompaction(
    dependencies.meter,
    dependencies.summarize,
    prepared,
    agent,
    lifecycle.compactionId,
    sourceCommandId,
    signal,
  )
  if (owner === null) signal?.throwIfAborted()
  if (stability === 'whole-surface') {
    assertWholeSurfaceUnchanged(dependencies.meter, session, summarized)
  } else {
    await assertSelectedSpanStable(dependencies.meter, session, summarized)
  }
  progress.stage = 'commit'
  const pending = commitCompactionBody(session, startEvent, summarized)
  const endEvent = session.append('compaction/end', lifecycle)
  return completeCompaction(pending, endEvent)
}

/**
 * Record the failed phase with exactly one `compaction/end { error }` attempt.
 * A close append that itself fails becomes the reported commit-stage failure
 * and leaves the unmatched start blocking, as the crash-safety contract
 * requires.
 */
async function closeFailedPhase(
  session: Session,
  lifecycle: BracketLifecycle,
  reason: unknown,
  stage: PhaseProgress['stage'],
): Promise<{ readonly failure: TransactionFailure; readonly closed: boolean }> {
  const captured = captureFailure(reason)
  const close = await settleCall(() => {
    session.append('compaction/end', { ...lifecycle, error: errorChain(captured) })
  })
  if (close.status === 'fulfilled') {
    return { failure: { error: captured, stage }, closed: true }
  }
  return { failure: { error: captureFailure(close.reason), stage: 'commit' }, closed: false }
}

/**
 * Call a durability flush inside the promise boundary so a synchronous throw
 * settles as a rejection instead of escaping the transaction.
 * @param flush - caller-supplied checkpoint thunk.
 * @returns the flush failure, or `undefined` when it completed.
 */
async function runDurabilityFlush(
  flush: () => Promise<void>,
): Promise<Error | undefined> {
  const outcome = await settleCall(flush)
  return outcome.status === 'fulfilled' ? undefined : captureFailure(outcome.reason)
}

/**
 * Preserve a thrown Error as-is and wrap any other shape in an Error carrying
 * its string rendering, so the durable error chain and the rethrown failure
 * both keep an Error the caller can throw again.
 * @param value - the settled rejection value, unconstrained at that boundary.
 * @returns the original Error, or an Error rendering any other thrown value.
 */
export function captureFailure(value: unknown): Error {
  if (value instanceof Error) return value
  return new Error(String(value))
}

/** Append one completed summary record and replacement body without yielding. */
function commitCompactionBody(
  session: Session,
  startEvent: SessionEvent<'compaction/start'>,
  summarized: SummarizedCompaction,
): Omit<CompactionResult, 'endSeq'> {
  const {
    start,
    end,
    shadowedSeqs,
    shadowedTokenCount,
    summary,
    provider,
    model,
    maxTokens,
    usage,
    checkpointMessage,
  } = summarized
  const callProvenance = summarized.llmStreamCall === true
    ? { rawOutput: summarized.rawOutput, llmStreamCall: true as const }
    : summarized.rawOutput === undefined ? {} : { rawOutput: summarized.rawOutput }
  const summaryEvent = session.append('compaction/summary', {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    summary,
    ...callProvenance,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
    provider,
    model,
    ...maxTokens === undefined ? {} : { maxTokens },
    ...usage === undefined ? {} : { usage },
  })
  session.append('user/message', checkpointMessage, {
    surfaceOp: { op: 'replace', start, end },
    sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...shadowedSeqs],
  })
  return {
    compactionId: startEvent.data.compactionId,
    ...startEvent.data.sourceCommandId === undefined
      ? {}
      : { sourceCommandId: startEvent.data.sourceCommandId },
    startSeq: startEvent.seq,
    summarySeq: summaryEvent.seq,
    summary,
    shadowedRange: { start, end },
    shadowedSeqs: [...shadowedSeqs],
    shadowedTokenCount,
  }
}

/** Attach the successfully appended close event to a pending result. */
function completeCompaction(
  pending: Omit<CompactionResult, 'endSeq'>,
  endEvent: SessionEvent<'compaction/end'>,
): CompactionResult {
  return { ...pending, endSeq: endEvent.seq }
}
