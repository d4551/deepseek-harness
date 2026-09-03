/**
 * Frozen pure-core contract: trigger detection and
 * menu reduction, zero React / DOM / cordis. Types only — implementations
 * live in sibling modules annotated with these
 * aliases; the service shell wires them to ctx.
 */
import type { TokenSpan } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputTriggerCandidate, TriggerChar, TriggerGuard, TriggerPosition } from '../types.ts'

/** A detected trigger token under the caret. */
export interface TriggerHit {
  readonly trigger: TriggerChar
  /** Text between the trigger char and the caret, live-filtered. */
  readonly query: string
  /** True only for an open quoted `@file` token. */
  readonly quoted: boolean
  /** leading = draft trimmed (whitespace incl. newlines) starts with the token. */
  readonly position: TriggerPosition
  /** Token span; draftRev injected by the caller. */
  readonly span: TokenSpan
}

/**
 * Detect a trigger token at the caret under the given guard tier.
 * `@` uses the shared file-reference start/whitespace grammar; `/` accepts
 * punctuation boundaries with URL carve-outs. `user@host` and URL `/` do not
 * trigger.
 * Returns null when no trigger is live at the caret.
 */
export type DetectTrigger = (draft: string, caret: number, guard: TriggerGuard) => TriggerHit | null

/** Row facts every menu group carries, whatever its load status. */
interface MenuGroupBase {
  readonly source: string
  /** False when candidate section rows own all visible group labeling. */
  readonly showGroupTitle?: boolean
  readonly items: readonly InputTriggerCandidate[]
}

/**
 * One source's group in the open menu. A `failed` group keeps its seat in the
 * roster and carries the load failure's message verbatim, so the view renders
 * the failure instead of an empty body and the menu does not auto-close into
 * a state the next keystroke would refetch.
 */
export type MenuGroup =
  | (MenuGroupBase & { readonly status: 'pending' })
  | (MenuGroupBase & { readonly status: 'ready' })
  | (MenuGroupBase & { readonly status: 'failed'; readonly error: string })

/** Menu state: one group per source; empty ready groups auto-close the menu. */
export interface MenuState {
  readonly open: boolean
  readonly hit: TriggerHit | null
  /** Monotonic per-hit generation; stale source settlements are dropped. */
  readonly generation: number
  readonly groups: readonly MenuGroup[]
  readonly highlight: { readonly source: string; readonly index: number } | null
}

/**
 * Menu reduction events. A source failure keeps the group and publishes its
 * message; only an unregistered source (`source-removed`) drops one silently.
 */
export type MenuEvent =
  | { readonly type: 'hit'; readonly hit: TriggerHit | null }
  | { readonly type: 'source-settled'; readonly generation: number; readonly source: string; readonly items?: readonly InputTriggerCandidate[] }
  | { readonly type: 'source-failed'; readonly generation: number; readonly source: string; readonly error: string }
  | { readonly type: 'source-retry'; readonly generation: number; readonly source: string }
  | { readonly type: 'source-removed'; readonly generation: number; readonly source: string }
  | { readonly type: 'move'; readonly dir: 1 | -1 }
  | { readonly type: 'hover'; readonly source: string; readonly index: number }
  | { readonly type: 'close' }

/** Pure menu reducer; returns the same reference when the event is stale or a no-op. */
export type MenuReduce = (state: MenuState, ev: MenuEvent) => MenuState

/**
 * Exact-name lookup in one source's ready group; null when absent or the
 * group is not ready.
 */
export type ExactMatch = (groups: MenuState['groups'], source: string, name: string) => InputTriggerCandidate | null
