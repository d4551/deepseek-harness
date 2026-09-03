/** All-human-messages model provider for `ctx.sessionTitle`. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  registerSessionTitleLlmProvider,
  SessionTitleLlmConfigFields,
} from '@deepseek-ai/dsh-session-title-llm'
import type { SessionTitleLlmConfig } from '@deepseek-ai/dsh-session-title-llm'

export const name = 'session-title-all-prompts-llm'
export const inject = ['sessionTitle', 'llm', 'sessions']

/** Required LLM policy; this plugin adds no defaults. */
export type Config = SessionTitleLlmConfig
/**
 * Loader schema over the seam's field validators. Each plugin exports its own
 * `Config` because the Loader and the config catalog read it from the entry
 * file; the fields themselves stay owned by `dsh-session-title-llm`.
 */
export const Config: z<Config> = z.object(SessionTitleLlmConfigFields)

/**
 * Register the all-prompts model provider.
 * @param ctx - context exposing session-title, LLM, and session services.
 * @param config - required route, target, byte, token, and timeout policy.
 */
export function apply(ctx: Context, config: Config): void {
  registerSessionTitleLlmProvider(ctx, config, name, 'all-prompts', messages => messages)
}
