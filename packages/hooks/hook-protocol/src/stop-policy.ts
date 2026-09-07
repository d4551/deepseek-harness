/**
 * What one dialect does with the shared `continue: false` and `systemMessage`
 * output fields, point by point, as its reference implementation applies them.
 * The extension points read this instead of guessing, so the two dialects can
 * differ where their references differ and agree everywhere else.
 * @module @deepseek-ai/dsh-hook-protocol/stop-policy
 */

/** One dialect's reference behavior for the shared halt and system-message fields. */
export interface HookStopPolicy {
  /**
   * What a `PreToolUse` hook's `continue: false` does: `halt` denies the call
   * and ends the turn (Claude Code); `proceed` warns and lets the call run
   * (Codex marks such a hook failed and continues the tool call).
   */
  readonly preTool: 'halt' | 'proceed'
  /**
   * What a `PostToolUse` hook's `continue: false` does: `replace-result` turns
   * the stop text into blocking feedback and the turn continues (Codex);
   * `none` leaves the result alone (Claude Code reads no `continue` here).
   */
  readonly postTool: 'replace-result' | 'none'
  /**
   * Whether a halting hook's `stopReason` is queued as context for the model's
   * next request (Claude Code) or only recorded on the turn's end (Codex).
   */
  readonly stopReasonToModel: boolean
  /** Points whose `systemMessage` the model sees as context on its next request. */
  readonly modelVisibleSystemMessages: readonly string[]
}
