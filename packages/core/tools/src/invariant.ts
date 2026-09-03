/** Package-owned tool-pipeline invariants. @module @deepseek-ai/dsh-tools/invariant */

import type { Context } from '@deepseek-ai/cordis'
import { advanceOpenTurn, stageSessionEvents } from '@deepseek-ai/dsh-session/invariant-staging'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { ToolExecution, ToolExecutionResult } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tools'

/** Cordis companion plugin name. */
export const name = 'tools-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

type ToolStage = 'pre' | 'execute' | 'post'

/** The two events that announce one code-dispatched sub-call. */
type DispatchEventType = 'tool/code-dispatch-start' | 'tool/code-dispatch'

/** Committed code-dispatch state for one session log. */
interface DispatchTrace {
  /** The open turn number, or null between turns. */
  openTurn: number | null
  /** The rootCallId committed for each subCallId the log already carries. */
  roots: Map<string, string>
}

/** The subCallId-to-rootCallId edge one validated dispatch event commits. */
interface DispatchEdge {
  child: string
  root: string
}

/** Whether an event announces a code-dispatched sub-call. */
function isDispatchEvent(event: SessionEvent): event is SessionEvent<DispatchEventType> {
  return event.type === 'tool/code-dispatch-start' || event.type === 'tool/code-dispatch'
}

/**
 * Validate one dispatch candidate against the committed trace: call ids are
 * present, the sub-call keeps one root, its parent belongs to that root, and
 * the announcement falls inside an open turn.
 */
function validateDispatch(
  trace: DispatchTrace,
  event: SessionEvent,
  fail: InvariantFailure,
): DispatchEdge | undefined {
  if (!isDispatchEvent(event)) return undefined
  const root = String(event.data.rootCallId)
  const parent = String(event.data.parentCallId)
  const child = String(event.data.subCallId)
  if (root.length === 0 || parent.length === 0 || child.length === 0) {
    fail(`${event.type} must carry non-empty rootCallId, parentCallId, and subCallId`)
  }
  const known = trace.roots.get(child)
  if (known !== undefined && known !== root) fail(`${event.type} changed rootCallId for subCallId ${child}`)
  if (parent !== root && trace.roots.get(parent) !== root) {
    fail(`${event.type} parentCallId ${parent} does not belong to rootCallId ${root}`)
  }
  if (trace.openTurn === null) fail(`${event.type} appended outside any open turn`)
  return { child, root }
}

/** Validate the immutable final execution/result snapshot. */
function validateResult(
  exec: Readonly<ToolExecution>,
  result: Readonly<ToolExecutionResult>,
  fail: InvariantFailure,
): void {
  if (!Object.isFrozen(exec)) fail('tools/result execution must be frozen before publication')
  if (!Object.isFrozen(result) || !Object.isFrozen(result.content)) {
    fail('tools/result outcome and content must be frozen before publication')
  }
  if (exec.name.length === 0 || String(exec.callId).length === 0) {
    fail('tools/result execution must carry non-empty name and callId')
  }
}

/** Install monotonic pipeline, final-snapshot, and code-dispatch enclosure checks. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const stages = new WeakMap<object, ToolStage>()
  stageSessionEvents<DispatchTrace, DispatchEdge>(ctx, fail, {
    seed: (session) => {
      const trace: DispatchTrace = { openTurn: null, roots: new Map() }
      for (const event of session.events) {
        const edge = validateDispatch(trace, event, fail)
        if (edge !== undefined) trace.roots.set(edge.child, edge.root)
        advanceOpenTurn(trace, event)
      }
      return trace
    },
    publish: (trace, event) => advanceOpenTurn(trace, event),
    stage: (trace, event) => validateDispatch(trace, event, fail),
    claims: isDispatchEvent,
    commit: (trace, edge) => {
      trace.roots.set(edge.child, edge.root)
      return trace
    },
    unstagedMessage: 'a code-dispatch record reached publication without enclosure validation',
  })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName === 'tools/pre-execute') {
      const exec = args[0] as ToolExecution
      if (stages.has(exec)) fail('tools/pre-execute repeated for one execution')
      stages.set(exec, 'pre')
      return
    }
    if (eventName === 'tools/execute') {
      const exec = args[0] as ToolExecution
      if (stages.get(exec) !== 'pre') fail('tools/execute must follow tools/pre-execute')
      stages.set(exec, 'execute')
      return
    }
    if (eventName === 'tools/post-execute') {
      const exec = args[0] as ToolExecution
      const previous = stages.get(exec)
      if (previous !== 'pre' && previous !== 'execute') {
        fail('tools/post-execute must follow tools/pre-execute or tools/execute')
      }
      stages.set(exec, 'post')
      return
    }
    if (eventName !== 'tools/result') return
    const [exec, result] = args as [Readonly<ToolExecution>, Readonly<ToolExecutionResult>]
    validateResult(exec, result, fail)
    stages.delete(exec)
  }, { global: true })
}, { inject: ['sessions'] })

/**
 * Register the tools invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
