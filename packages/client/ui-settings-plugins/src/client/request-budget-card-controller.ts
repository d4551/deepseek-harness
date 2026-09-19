import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { RequestBudgetLimits } from '@deepseek-ai/dsh-session/types'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { numberField } from './card-field-spec.ts'

/**
 * Claim one wire section as the request-budget limits.
 * @param section - Host-served namespace value.
 * @returns the claimed limits, or undefined when either ceiling is not a finite number.
 */
export function decodeRequestBudgetLimits(section: unknown): RequestBudgetLimits | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const maxAgentAttempts = Reflect.get(section, 'maxAgentAttempts')
  const maxRootAttempts = Reflect.get(section, 'maxRootAttempts')
  if (typeof maxAgentAttempts !== 'number' || !Number.isFinite(maxAgentAttempts)) return undefined
  if (typeof maxRootAttempts !== 'number' || !Number.isFinite(maxRootAttempts)) return undefined
  return { maxAgentAttempts, maxRootAttempts }
}

/** Staged request limits and their host settings state. */
export interface RequestBudgetCardState extends CardShell {
  maxAgentAttempts: CardFieldState
  maxRootAttempts: CardFieldState
}

/** Registration-owned request limit drafts and actions. */
export interface RequestBudgetCardFace extends CardActions {
  hooks: {
    requestBudgetCard: SnapshotStore<RequestBudgetCardState>
  }
}

/** Edits both limits in one host-validated settings mutation. */
export class RequestBudgetCardController {
  private readonly form: CardForm<RequestBudgetLimits>
  private readonly store: SnapshotStore<RequestBudgetCardState>

  constructor(scope: SettingsScope<RequestBudgetLimits>) {
    this.form = new CardForm(scope, [
      numberField('maxRootAttempts', 'positive-integer'),
      numberField('maxAgentAttempts', 'positive-integer'),
    ])
    this.store = this.form.bind(() => ({
      ...this.form.shell(),
      maxAgentAttempts: this.form.field('maxAgentAttempts'),
      maxRootAttempts: this.form.field('maxRootAttempts'),
    }))
  }

  inject(): RequestBudgetCardFace {
    return { hooks: { requestBudgetCard: this.store }, ...this.form.actions() }
  }
}
