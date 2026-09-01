/**
 * Approval assessor guard plugin. Hooks the `approval/request` waterfall to
 * detect work-avoidance approval requests (asking permission to skip, defer,
 * or soften tasks the user already authorized) and rejects them with a
 * redirect to the original user instructions. Legitimate safety gates
 * (sandbox escalation, destructive operations) pass through untouched.
 *
 * Toggleable via settings (`approval-assessor` namespace) or composition
 * config. When disabled, the listener delegates every request to the next
 * answerer without inspection.
 * @module @deepseek-ai/dsh-approval-assessor
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
export declare const name = 'approval-assessor'
export declare const inject: string[]
/** Plugin configuration, shared between composition entry and settings. */
export interface Config {
  /** Whether the assessor is active. Default `true`. */
  enabled?: boolean
  /**
     * Additional evasion patterns (JavaScript regex source strings) appended
     * to the built-in set. Compiled at load time; invalid regex fails loud.
     */
  extraPatterns?: string[]
}
export declare const Config: z<Config>
/**
 * Install the approval assessor. Registers a settings namespace (when the
 * settings service is available) and hooks the `approval/request` waterfall.
 * @param ctx - plugin context.
 * @param entry - composition entry config.
 */
export declare function apply(ctx: Context, entry: Config): void
//# sourceMappingURL=index.d.ts.map
