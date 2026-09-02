/** The approval-assessor card's staged form over the `approval-assessor` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { booleanField, stringListField } from './card-field-spec.ts'

/**
 * Namespace of the approval assessor's user-owned settings. Spelled here
 * rather than imported: a client package must not depend on a Host package.
 */
export const APPROVAL_ASSESSOR_NS = 'approval-assessor'

/** The approval-assessor fields this card edits. */
export interface ApprovalAssessorSettings {
  /** Whether the assessor screens approval reasons. */
  enabled?: boolean
  /** Extra evasion-pattern regex sources appended to the built-in set. */
  extraPatterns?: string[]
}

/** What the approval-assessor card renders. */
export interface ApprovalAssessorCardState extends CardShell {
  /** Assessor enablement. */
  enabled: CardFieldState
  /** Extra evasion patterns, one per line. */
  extraPatterns: CardFieldState
}

/** The registration-side face the approval-assessor card's slot entry injects. */
export interface ApprovalAssessorCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useApprovalAssessorCard. */
    approvalAssessorCard: SnapshotStore<ApprovalAssessorCardState>
  }
}

/** Bridges the `approval-assessor` scope onto the card's staged form. */
export class ApprovalAssessorCardController {
  private readonly form: CardForm<ApprovalAssessorSettings>
  private readonly store: SnapshotStore<ApprovalAssessorCardState>

  /** @param scope - the bound settings scope for the `approval-assessor` namespace. */
  constructor(scope: SettingsScope<ApprovalAssessorSettings>) {
    this.form = new CardForm(scope, [booleanField('enabled'), stringListField('extraPatterns')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ApprovalAssessorCardState {
    return {
      ...this.form.shell(),
      enabled: this.form.field('enabled'),
      extraPatterns: this.form.field('extraPatterns'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): ApprovalAssessorCardFace {
    return { hooks: { approvalAssessorCard: this.store }, ...this.form.actions() }
  }
}
