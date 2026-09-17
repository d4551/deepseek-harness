/** Host-owned request limits, resolved from deployment policy and durable user settings. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { REQUEST_BUDGET_SETTINGS_NAMESPACE } from '@deepseek-ai/dsh-session/types'
import type { RequestBudgetLimits, RequestBudgetPolicy } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-agent'

/** Settings expose limits; the deployment owns the accounting policy identity. */
const LIMIT_FIELDS = {
  maxAgentAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
  maxRootAttempts: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required(),
}
const LIMITS_SCHEMA: z<RequestBudgetLimits> = z.object(LIMIT_FIELDS)

/** Optional agent-loop composition policy. */
export const REQUEST_BUDGET_POLICY_SCHEMA: z<RequestBudgetPolicy> = z.object({
  policyId: z.string().min(1).required(),
  ...LIMIT_FIELDS,
})

/** Reject contradictory limits before persistence or provider dispatch. */
function validateLimits(value: RequestBudgetLimits): void {
  if (Object.keys(value).length !== 2) throw new Error('request settings accept only the two request limits')
  if (!Number.isSafeInteger(value.maxAgentAttempts) || value.maxAgentAttempts < 1
    || !Number.isSafeInteger(value.maxRootAttempts) || value.maxRootAttempts < 1) {
    throw new Error('request limits must be positive safe integers')
  }
  if (value.maxAgentAttempts > value.maxRootAttempts) {
    throw new Error('delegated-agent request limit exceeds the whole-task limit')
  }
}

/** Register once in the host; every reservation reads the latest committed limits. */
export function installRequestBudgetSettings(ctx: Context, policy: RequestBudgetPolicy): void {
  const { policyId, maxAgentAttempts, maxRootAttempts } = REQUEST_BUDGET_POLICY_SCHEMA(policy)
  if (policyId.trim() !== policyId) throw new Error('request policy identity must be trimmed')
  validateLimits({ maxAgentAttempts, maxRootAttempts })
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(settingsNamespace(REQUEST_BUDGET_SETTINGS_NAMESPACE), LIMITS_SCHEMA, {
      base: { maxAgentAttempts, maxRootAttempts },
      applies: 'live',
      validate: (value) => {
        if (settingsCtx.agents.currentInitiator() !== undefined) {
          throw new Error('request limits require a user settings operation')
        }
        validateLimits(value)
      },
    })
    settingsCtx.provide('requestBudgetPolicy', {
      get: () => {
        const limits = scope.get()
        return Object.freeze({ policyId, maxAgentAttempts: limits.maxAgentAttempts, maxRootAttempts: limits.maxRootAttempts })
      },
    })
  })
}
