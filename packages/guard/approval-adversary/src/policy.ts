/** One schema for composition defaults and persisted approval policy. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** User-owned authorization review policy. */
export interface ApprovalAdversarySettings {
  /** Whether automatic review owns approval decisions. */
  enabled: boolean
  /** Explicit review route; both fields must be supplied together. */
  provider?: string
  /** Model on the explicit provider route; supplied with provider. */
  model?: string
  /** End-to-end review deadline in milliseconds. */
  timeoutMs: number
  /** Output-token cap for the verdict. */
  maxOutputTokens: number
  /** Maximum length of the complete serialized evidence message. */
  maxEvidenceChars: number
  /** Additional restrictions on approval, at most 4096 characters. */
  instructions: string
}

/** Composition values resolved through the persisted policy schema. */
export type Config = Partial<ApprovalAdversarySettings>

/** Settings namespace exposed by the approval-review editor. */
export const APPROVAL_ADVERSARY_SETTINGS_NAMESPACE = settingsNamespace('approval-adversary')

/** Bounds and defaults shared by composition and persisted settings. */
export const Config: z<Config, ApprovalAdversarySettings> = z.object({
  enabled: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxOutputTokens: z.number().step(1).min(1).default(256),
  maxEvidenceChars: z.number().step(1).min(1).default(4000),
  instructions: z.string().max(4096).default(''),
})

/** Complete policy schema installed in the settings service. */
export const APPROVAL_ADVERSARY_SETTINGS_SCHEMA: z<ApprovalAdversarySettings> = Config

/**
 * Reject whitespace route identifiers and incomplete explicit route pairs.
 * @param settings - schema-resolved policy to validate.
 */
export function assertRoutePair(settings: ApprovalAdversarySettings): void {
  for (const route of [settings.provider, settings.model]) {
    if (route !== undefined && route.trim() !== route) throw new Error('approval-adversary: route identifiers must not contain surrounding whitespace')
  }
  if (Boolean(settings.provider) !== Boolean(settings.model)) {
    throw new Error('approval-adversary: provider and model must be supplied together')
  }
}
