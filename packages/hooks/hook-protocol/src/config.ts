/**
 * Load and parse a bridge's hook config file. Both dialects store an event map
 * of matcher groups, discard matchers on the two events that have no matcher
 * subject, reject an invalid matcher for the whole file, and abort registration
 * when the file cannot be read or parsed. Each bridge supplies only the per-hook
 * entry conversion its own format defines.
 * @module @deepseek-ai/dsh-hook-protocol/config
 */

import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import { matcherDiagnostic } from './matcher.ts'
import type { CommandHook, MatcherGroup, MatcherMode } from './types.ts'

/**
 * Events with no matcher subject in either dialect. A `matcher` configured on
 * one is discarded before validation, so an unusable pattern there cannot
 * reject the file.
 */
const MATCHERLESS_EVENTS: ReadonlySet<string> = new Set(['UserPromptSubmit', 'Stop'])

/** A parsed hook config: event name → the matcher groups that run for it. */
export type HookGroups = Record<string, MatcherGroup[]>

/** The outcome of parsing one config file: the runnable groups plus what was skipped. */
export interface ParsedHookGroups<Skipped> {
  /** The runnable groups, keyed by event; an event with no runnable group is absent. */
  config: HookGroups
  /** Entries the dialect refused to run, in file order, for the bridge to warn about. */
  skipped: Skipped[]
}

/** What one dialect contributes to the shared group parse. */
export interface HookGroupParseRules<Skipped> {
  /** The events this dialect supports; any other key in the file is ignored. */
  events: readonly string[]
  /** Matcher interpretation used for the config-time diagnostic. */
  mode: MatcherMode
  /**
   * Convert one raw hook object into a runnable command.
   * @param raw - the hook entry, already known to be a plain object.
   * @param event - the event the entry was configured under.
   * @param skip - records a dialect-specific skip reason for the bridge to warn about.
   * @returns the runnable command, or `undefined` when the entry is skipped or malformed.
   */
  hook: (raw: Record<string, unknown>, event: string, skip: (entry: Skipped) => void) => CommandHook | undefined
}

/** A plain (non-null, non-array) object, else undefined. */
function asObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

/**
 * Parse either a settings-style `{ hooks: … }` wrapper or a bare event map into
 * runnable matcher groups. Malformed entries are ignored rather than failing
 * boot, and unsupported events are ignored before their groups are parsed. A
 * supported runnable group whose matcher is an invalid regex throws a
 * `SyntaxError`, letting the bridge reject the whole config before it registers
 * any listener.
 * @param raw - the parsed JSON config: a wrapper object with a `hooks` key, or the bare event map.
 * @param rules - the dialect's supported events, matcher mode, and per-hook conversion.
 * @returns the runnable per-event groups plus every skipped entry the dialect recorded.
 */
export function parseHookGroups<Skipped>(
  raw: unknown,
  rules: HookGroupParseRules<Skipped>,
): ParsedHookGroups<Skipped> {
  const config: HookGroups = {}
  const skipped: Skipped[] = []
  const root = asObject(raw)
  const hooksMap = root ? asObject(root.hooks) ?? root : undefined
  if (!hooksMap) return { config, skipped }

  for (const event of rules.events) {
    const rawGroups = hooksMap[event]
    if (!Array.isArray(rawGroups)) continue
    const groups: MatcherGroup[] = []
    for (const rawGroup of rawGroups) {
      const group = asObject(rawGroup)
      if (!group || !Array.isArray(group.hooks)) continue
      const commands: MatcherGroup['hooks'] = []
      for (const rawHook of group.hooks) {
        const hook = asObject(rawHook)
        if (!hook) continue
        const command = rules.hook(hook, event, (entry) => { skipped.push(entry) })
        if (command !== undefined) commands.push(command)
      }
      if (commands.length === 0) continue
      const matcher = MATCHERLESS_EVENTS.has(event) || typeof group.matcher !== 'string'
        ? undefined
        : group.matcher
      const diagnostic = matcherDiagnostic(matcher, rules.mode)
      if (diagnostic !== undefined) throw new SyntaxError(`${diagnostic} on event ${JSON.stringify(event)}`)
      groups.push({ ...matcher !== undefined ? { matcher } : {}, hooks: commands })
    }
    if (groups.length > 0) config[event] = groups
  }

  return { config, skipped }
}

/** What loading one bridge's process-level hook config file needs. */
export interface LoadHookGroupsOptions {
  /** The bridge plugin name, prefixed onto every diagnostic. */
  plugin: string
  /** Path to the config file; a relative path resolves against the process launch cwd. */
  configPath: string
  /**
   * Parse the file's JSON into runnable groups.
   * @param raw - the parsed JSON value.
   * @returns the runnable groups plus already-worded warnings about skipped entries.
   */
  parse: (raw: unknown) => { config: HookGroups; warnings: string[] }
}

/**
 * Read and parse a bridge's config file once at load. A read, JSON, or matcher
 * failure is warned and turns into `undefined`, which the bridge treats as
 * "register nothing" — a malformed config never crashes the process it loads in.
 * @param ctx - context whose logger receives the skip and load-failure warnings.
 * @param options - the plugin name, config path, and dialect parse step.
 * @returns the runnable per-event groups, or `undefined` when the config is unusable.
 */
export function loadHookGroups(ctx: Context, options: LoadHookGroupsOptions): HookGroups | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(options.configPath, 'utf8'))
    const { config, warnings } = options.parse(raw)
    for (const warning of warnings) ctx.logger.warn(`${options.plugin}: ${warning}`)
    return config
  } catch (error: unknown) {
    ctx.logger.warn(`${options.plugin}: could not load hook config "${options.configPath}": ${String(error)} — no hooks registered`)
    return undefined
  }
}

/**
 * Reject a non-positive bound before it silently misbehaves in a slice or timer.
 * Bridges call this before parsing their config so a bad value cannot be hidden
 * by the config-load early return.
 * @param plugin - the bridge plugin name, prefixed onto the error.
 * @param field - the config field being validated.
 * @param value - the configured value.
 */
export function assertPositiveInteger(plugin: string, field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${plugin}: ${field} must be a positive integer`)
  }
}
