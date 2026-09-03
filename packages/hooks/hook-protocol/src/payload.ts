/**
 * Payload primitives both dialects compute identically: the open-turn cursor,
 * content-block flattening, and the session identity fields Codex inherited
 * from Claude Code. Each bridge still owns the rest of its payload field set
 * and the absent-transcript spelling its schema uses.
 * @module @deepseek-ai/dsh-hook-protocol/payload
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
// Declares the optional `sessionPersistence` service read for `transcript_path`.
import type {} from '@deepseek-ai/dsh-session-persistence'

/** The four session-identity fields every hook payload carries in both dialects. */
export interface HookEventFields {
  /** The session the hook runs for; `''` when no agent owns the run. */
  session_id: string
  /** The session transcript's path, or the dialect's absent spelling when no file locates. */
  transcript_path: string | null
  /** The session workspace the hook process runs in; the launch cwd without an agent. */
  cwd: string
  /** The hook point that is firing (`PreToolUse`, `Stop`, …). */
  hook_event_name: string
}

/**
 * The last open turn number in the agent's log.
 * @param agent - the agent owning the run, absent outside an agent-scoped extension point.
 * @returns the latest `turn/start` number, or 0 without an agent.
 */
export function lastTurn(agent: Agent | undefined): number {
  if (!agent) return 0
  const last = [...agent.session.events].findLast(e => e.type === 'turn/start')
  /* v8 ignore next -- agent-present callers are tool/stop extension points inside an open turn. */
  return last?.type === 'turn/start' ? last.data.turn : 0
}

/**
 * Flatten content blocks to the text a hook payload carries (the common case).
 * @param content - the message or result blocks to flatten.
 * @returns the concatenated text of every text block, in order.
 */
export function blocksToText(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

/**
 * Build the identity fields shared by every hook payload in both dialects.
 * @param ctx - context whose optional `sessionPersistence` service locates the transcript.
 * @param agent - the agent owning the run, absent outside an agent-scoped extension point.
 * @param event - the hook point firing, written to `hook_event_name`.
 * @param absentTranscriptPath - what the dialect writes when no transcript locates (CC `''`, Codex `null`).
 * @returns the identity fields to spread into the dialect's payload.
 */
export function hookEventFields(
  ctx: Context,
  agent: Agent | undefined,
  event: string,
  absentTranscriptPath: string | null,
): HookEventFields {
  return {
    session_id: agent?.session.header.id ?? '',
    transcript_path: agent === undefined
      ? absentTranscriptPath
      : ctx.get('sessionPersistence')?.locate(agent.session.header)?.path ?? absentTranscriptPath,
    cwd: agent?.session.header.cwd ?? process.cwd(),
    hook_event_name: event,
  }
}
