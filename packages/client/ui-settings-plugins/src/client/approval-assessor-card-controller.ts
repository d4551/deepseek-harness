import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { booleanField, stringListField } from './card-field-spec.ts'

export const APPROVAL_ASSESSOR_NS = 'approval-assessor'

export interface ApprovalAssessorSettings {
  enabled?: boolean
  extraPhrases?: readonly string[]
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
