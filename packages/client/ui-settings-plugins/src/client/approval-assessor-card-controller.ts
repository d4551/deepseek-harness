import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { booleanField, stringListField } from './card-field-spec.ts'

export const APPROVAL_ASSESSOR_NS = 'approval-assessor'

export interface ApprovalAssessorSettings {
  enabled?: boolean
  extraPhrases?: readonly string[]
}

/**
 * Claim one wire section as the assessor card's durable fields.
 * @param section - Host-served namespace value.
 * @returns the claimed section, or undefined when a named field is the wrong kind.
 */
export function decodeApprovalAssessorSettings(section: unknown): ApprovalAssessorSettings | undefined {
  if (typeof section !== 'object' || section === null || Array.isArray(section)) return undefined
  const enabled = Reflect.get(section, 'enabled')
  const extraPhrases = Reflect.get(section, 'extraPhrases')
  if (enabled !== undefined && typeof enabled !== 'boolean') return undefined
  if (extraPhrases !== undefined) {
    if (!Array.isArray(extraPhrases) || !extraPhrases.every(phrase => typeof phrase === 'string')) {
      return undefined
    }
  }
  const claimed: ApprovalAssessorSettings = {}
  if (enabled !== undefined) claimed.enabled = enabled
  if (extraPhrases !== undefined) claimed.extraPhrases = extraPhrases
  return claimed
}

export interface ApprovalAssessorCardState extends CardShell {
  enabled: CardFieldState
  extraPhrases: CardFieldState
}

export interface ApprovalAssessorCardFace extends CardActions {
  hooks: { approvalAssessorCard: SnapshotStore<ApprovalAssessorCardState> }
}

export class ApprovalAssessorCardController {
  private readonly form: CardForm<ApprovalAssessorSettings>
  private readonly store: SnapshotStore<ApprovalAssessorCardState>

  constructor(scope: SettingsScope<ApprovalAssessorSettings>) {
    this.form = new CardForm(scope, [booleanField('enabled'), stringListField('extraPhrases')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ApprovalAssessorCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      extraPhrases: this.form.field('extraPhrases'),
    }
  }

  inject(): ApprovalAssessorCardFace {
    return { hooks: { approvalAssessorCard: this.store }, ...this.form.actions() }
  }
}
