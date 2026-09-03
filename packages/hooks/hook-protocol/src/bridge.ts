/**
 * The execution half of a hook bridge: resolve the bridge's limits, load its
 * config, match a point's configured groups, run each command with the bridge's
 * stdin framing and environment, record the durable invoked/result pair, and
 * fold the outcomes. One tracker per bridge holds emit-shaped runs to
 * quiescence. A bridge keeps its payload field set, its config entry format,
 * and the decisions it honors; everything a dialect does not decide lives here.
 * @module @deepseek-ai/dsh-hook-protocol/bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, MessageSource } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { assertPositiveInteger, loadHookGroups } from './config.ts'
import type { HookGroups } from './config.ts'
import { createDetachedRuns } from './detached.ts'
import { appendHookInvoked, appendHookResult, DEFAULT_STDERR_SUMMARY_MAX_CHARS } from './events.ts'
import { matchesMatcher } from './matcher.ts'
import { mergeHookOutputs } from './merge.ts'
import type { MergedHookOutcome } from './merge.ts'
import { DEFAULT_HOOK_TIMEOUT_MS, runHook } from './runner.ts'
import type { HookDialect, HookOutput } from './types.ts'

/**
 * Process-wide invocation counter behind every `handlerId`. A handler id is
 * `<dialect>:<point>:<n>`, so it stays unique across bridges and across
 * repeated mounts of the same bridge within one process.
 */
let handlerCounter = 0

/** A protocol field the codec decodes but no extension point acts on yet. */
export type UnhonoredHookField = 'updatedInput' | 'systemMessage'

/** The warning each unhonored field produces, so both bridges word it identically. */
const UNHONORED_WARNINGS: Record<UnhonoredHookField, (point: string) => string> = {
  updatedInput: point => `${point} hook requested updatedInput, which is not yet honored (ignored)`,
  systemMessage: point => `${point} hook emitted a systemMessage, which is not yet surfaced (ignored)`,
}

/** Everything one bridge states about itself when it loads. */
export interface HookBridgeOptions {
  /** The dialect: stamped on `hook/invoked`, prefixes handler ids, and selects matcher interpretation. */
  dialect: HookDialect
  /** The bridge plugin name, prefixed onto diagnostics and stamped as the injected message source. */
  plugin: string
  /** Path to the bridge's config file; a relative path resolves against the process launch cwd. */
  configPath: string
  /**
   * Parse the config file's JSON into runnable groups.
   * @param raw - the parsed JSON value.
   * @returns the runnable groups plus already-worded warnings about skipped entries.
   */
  parse: (raw: unknown) => { config: HookGroups; warnings: string[] }
  /** Timeout for a hook whose config sets none; omitted means {@link DEFAULT_HOOK_TIMEOUT_MS}. */
  defaultTimeoutMs?: number
  /** Cap for the `hook/result` stderr summary; omitted means {@link DEFAULT_STDERR_SUMMARY_MAX_CHARS}. */
  stderrSummaryMaxChars?: number
  /** Whether the stdin payload ends with a newline (Claude Code yes, Codex no). */
  trailingNewline: boolean
  /** Fields to warn about when a hook returns them, in warning order. */
  unhonored: readonly UnhonoredHookField[]
  /**
   * Environment exported to each hook process. Omit it for a dialect that
   * exports none.
   * @param workdir - the session workspace the hook will run in, absent without an agent.
   * @returns the extra environment entries, or `undefined` for none.
   */
  env?: (workdir: string | undefined) => Record<string, string> | undefined
}

/** The loaded config and resolved limits one bridge runs with. */
interface HookBridgeSpec {
  /** The parsed config: hook point → the matcher groups configured for it. */
  groups: HookGroups
  /** Timeout applied to a hook whose config sets none. */
  defaultTimeoutMs: number
  /** Character cap for the `hook/result` event's persisted stderr summary. */
  stderrSummaryMaxChars: number
}

/** What one hook point invocation knows about the operation that triggered it. */
export interface HookRunScope {
  /** The agent owning the run; absent outside an agent-scoped extension point. */
  agent?: Agent
  /** The open turn recording the invoked/result pair; absent on detached lifecycle points. */
  turn?: number
  /** The owning operation's cancellation signal, handed to every hook process. */
  readonly signal: AbortSignal
  /**
   * Treat clean plain (non-JSON) stdout as `additionalContext` when the hook
   * emitted no structured context. Codex does this on its two context-bearing
   * points; Claude Code never does.
   */
  plainStdoutAsContext?: boolean
}

/** The shared execution surface a dialect bridge drives its extension points with. */
export interface HookBridge {
  /** The `{kind:'plugin'}` source stamped on every message this bridge injects or steers. */
  readonly source: MessageSource
  /** The abort signal every detached run must hand to its hook processes. */
  readonly detachedSignal: AbortSignal
  /**
   * Run every command hook configured for `point` whose matcher selects
   * `matchQuery`, with `payload` on stdin, and fold the results. A scope naming
   * an open turn writes a `hook/invoked`/`hook/result` pair per hook; detached
   * lifecycle points omit the pair.
   * @param point - the hook point firing.
   * @param matchQuery - the event's matcher subject (tool name, session source, …); `''` when the event ignores matchers.
   * @param payload - the dialect payload written to each hook's stdin.
   * @param scope - the owning operation's agent, turn, signal, and stdout-context rule.
   * @returns the merged, already-most-restrictive outcome for the caller to map onto its decision.
   */
  run: (point: string, matchQuery: string, payload: unknown, scope: HookRunScope) => Promise<MergedHookOutcome>
  /**
   * Build the model context a merged outcome carries.
   * @param merged - the folded outcome of one hook point.
   * @returns the context message, or `undefined` when no hook contributed context.
   */
  context: (merged: MergedHookOutcome) => UserMessage | undefined
  /**
   * Hold one emit-shaped run chain until it settles, so disposal can drain it.
   * Pass the full chain including its continuation and error handler.
   * @param run - the detached run chain.
   */
  detach: (run: Promise<unknown>) => void
  /**
   * Warn that a detached run rejected; the turn it belonged to has already moved on.
   * @param point - the hook point whose run failed.
   * @param error - the rejection value.
   */
  warnFailure: (point: string, error: unknown) => void
}

/**
 * Validate the bridge's limits, load its config once, and build the execution
 * surface. Limit validation runs before the config load so a bad limit cannot
 * be hidden by the load's early return, and the detached-drain disposer is
 * registered only for a bridge that will actually run hooks.
 * @param ctx - the bridge plugin's context; supplies the shell executor and logger.
 * @param options - everything the bridge states about itself at load.
 * @returns the bridge surface, or `undefined` when the config is unusable and the bridge must register nothing.
 */
export function startHookBridge(ctx: Context, options: HookBridgeOptions): HookBridge | undefined {
  const stderrSummaryMaxChars = options.stderrSummaryMaxChars ?? DEFAULT_STDERR_SUMMARY_MAX_CHARS
  assertPositiveInteger(options.plugin, 'stderrSummaryMaxChars', stderrSummaryMaxChars)
  const groups = loadHookGroups(ctx, options)
  if (groups === undefined) return undefined
  return createBridge(ctx, options, {
    groups,
    defaultTimeoutMs: options.defaultTimeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS,
    stderrSummaryMaxChars,
  })
}

/** Build the execution surface for a bridge whose config loaded. */
function createBridge(ctx: Context, options: HookBridgeOptions, spec: HookBridgeSpec): HookBridge {
  const detached = createDetachedRuns()
  ctx.effect(() => () => detached.drain(), `${options.plugin}: drain detached hook runs`)
  const source: MessageSource = { kind: 'plugin', plugin: options.plugin }

  async function run(
    point: string,
    matchQuery: string,
    payload: unknown,
    scope: HookRunScope,
  ): Promise<MergedHookOutcome> {
    const outputs: HookOutput[] = []
    // Hooks run in the agent's session workspace (the `session/new` cwd on the
    // session header), not the launch dir of the process hosting the bridge.
    const workdir = scope.agent?.session.header.cwd
    const env = options.env?.(workdir)
    for (const group of spec.groups[point] ?? []) {
      if (!matchesMatcher(group.matcher, matchQuery, options.dialect)) continue
      for (const hook of group.hooks) {
        const handlerId = `${options.dialect}:${point}:${++handlerCounter}`
        const session = scope.agent?.session
        if (session && scope.turn !== undefined) {
          appendHookInvoked(session, {
            turn: scope.turn, point, dialect: options.dialect, handlerId,
            ...group.matcher !== undefined ? { matcher: group.matcher } : {},
          })
        }
        const { output, durationMs } = await runHook(ctx.shell, hook, {
          payload,
          defaultTimeoutMs: spec.defaultTimeoutMs,
          ...env ? { env } : {},
          ...workdir !== undefined ? { cwd: workdir } : {},
          signal: scope.signal,
          trailingNewline: options.trailingNewline,
          // Discard a `hookSpecificOutput` block whose `hookEventName` names a
          // different event than the one firing (the schemas key it by event).
          expectedEventName: point,
        }, () => performance.now())
        // Clean plain stdout becomes context only when no structured context
        // exists; nonzero output and raw JSON never leak as prose.
        if (scope.plainStdoutAsContext === true && output.exitCode === 0
          && output.additionalContext === undefined
          && output.stdout.length > 0 && !output.stdout.startsWith('{')) {
          output.additionalContext = output.stdout
        }
        outputs.push(output)
        for (const field of options.unhonored) {
          if (output[field] !== undefined) ctx.logger.warn(`${options.plugin}: ${UNHONORED_WARNINGS[field](point)}`)
        }
        if (session && scope.turn !== undefined) {
          appendHookResult(session, {
            turn: scope.turn, point, handlerId, output,
            stderrSummaryMaxChars: spec.stderrSummaryMaxChars, durationMs,
          })
        }
      }
    }
    // TODO(hook-continue-false): `stop` is logged but needs a run-level halt mechanism.
    return mergeHookOutputs(outputs)
  }

  return {
    source,
    detachedSignal: detached.signal,
    run,
    context(merged: MergedHookOutcome): UserMessage | undefined {
      if (merged.additionalContext.length === 0) return undefined
      const content: ContentBlock[] = merged.additionalContext.map(text => ({ type: 'text', text }))
      return createUserMessage({ content, source })
    },
    detach(chain: Promise<unknown>): void {
      detached.track(chain)
    },
    warnFailure(point: string, error: unknown): void {
      ctx.logger.warn(`${options.plugin}: ${point} hook failed: ${String(error)}`)
    },
  }
}
