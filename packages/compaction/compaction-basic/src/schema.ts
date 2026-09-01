/**
 * Loader-facing configuration schemas for compaction-basic.
 *
 * @module @deepseek-ai/dsh-compaction-basic/schema
 */

import z from '@deepseek-ai/schemastery'
import type { ModelCompactPolicyConfig } from './types.ts'

/** Number schema for `thresholdRatio`. */
export const thresholdRatioSchema = z.number()
/** Number schema for `targetRatio`. */
export const targetRatioSchema = z.number()
/** Number schema for `retainRatio`. */
export const retainRatioSchema = z.number()
/** Non-negative integer schema for `retainTokens`. */
export const retainTokensSchema = z.number().step(1).min(0)
/** String schema for `summarizationProvider`. */
export const summarizationProviderSchema = z.string()
/** String schema for `summarizationModel`. */
export const summarizationModelSchema = z.string()
/** Positive integer schema for `maxTokens`. */
export const maxTokensSchema = z.number().step(1).min(1)
/** Non-negative integer schema for `compactionRetries`. */
export const compactionRetriesSchema = z.number().step(1).min(0)
/** Non-negative integer schema for `maxOverflowRetries`. */
export const maxOverflowRetriesSchema = z.number().step(1).min(0)

/** Policy fields shared by the top-level config and each exact-target override. */
export const policyConfigFields = {
  thresholdRatio: thresholdRatioSchema,
  targetRatio: targetRatioSchema,
  retainRatio: retainRatioSchema,
  retainTokens: retainTokensSchema,
  summarizationProvider: summarizationProviderSchema,
  summarizationModel: summarizationModelSchema,
  maxTokens: maxTokensSchema,
  compactionRetries: compactionRetriesSchema,
  maxOverflowRetries: maxOverflowRetriesSchema,
}

/** One exact provider/model policy override schema. */
export const modelPolicySchema: z<ModelCompactPolicyConfig> = z.object({
  provider: z.string().required(),
  model: z.string().required(),
  ...policyConfigFields,
})
