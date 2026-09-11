/** One schema for composition defaults and persisted approval policy. */

import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

export interface ApprovalAdversarySettings {
  /** Whether automatic review owns approval decisions. */
  enabled: boolean
  /** Explicit review route; both fields must be supplied together. */
  provider?: string
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

export type Config = Partial<ApprovalAdversarySettings>

export const APPROVAL_ADVERSARY_SETTINGS_NAMESPACE = settingsNamespace('approval-adversary')

export const APPROVAL_ADVERSARY_SETTINGS_SCHEMA: z<ApprovalAdversarySettings> = z.object({
  enabled: z.boolean().default(false),
  provider: z.string(),
  model: z.string(),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxOutputTokens: z.number().step(1).min(1).default(256),
  maxEvidenceChars: z.number().step(1).min(1).default(4000),
  instructions: z.string().max(4096).default(''),
})

export const Config: z<Config> = APPROVAL_ADVERSARY_SETTINGS_SCHEMA

/** Reject whitespace route identifiers and incomplete explicit route pairs. */
export function assertRoutePair(settings: ApprovalAdversarySettings): void {
  for (const route of [settings.provider, settings.model]) {
    if (route !== undefined && route.trim() !== route) throw new Error('approval-adversary: route identifiers must not contain surrounding whitespace')
  }
  if (Boolean(settings.provider) !== Boolean(settings.model)) {
    throw new Error('approval-adversary: provider and model must be supplied together')
  }
}
