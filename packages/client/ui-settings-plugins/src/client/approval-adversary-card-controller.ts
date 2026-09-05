/** The adversarial-review card's staged form over the `approval-adversary` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { booleanField, numberField, textField } from './card-field-spec.ts'

/**
 * Namespace of the adversary's user-owned settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const APPROVAL_ADVERSARY_NS = 'approval-adversary'

/** The fields the Host section carries, as the card edits them. */
export interface ApprovalAdversarySettings {
  /** Whether the reviewer decides approval requests instead of delegating them. */
  enabled?: boolean
  /** Explicit provider route for the review call; paired with `model`. */
  provider?: string
  /** Explicit model id for the review call; paired with `provider`. */
  model?: string
  /** What happens to a request the review could not decide. */
  fallback?: 'delegate' | 'reject'
  /** End-to-end review call deadline in milliseconds. */
  timeoutMs?: number
  /** Output-token cap for the verdict. */
  maxOutputTokens?: number
  /** Character cap for each excerpt the reviewer reads and each excerpt a notice quotes. */
  maxExcerptChars?: number
  /** Deployment instruction appended after the built-in review instruction. */
  instructions?: string
}

/** What the adversarial-review card renders. */
export interface ApprovalAdversaryCardState extends CardShell {
  enabled: CardFieldState
  provider: CardFieldState
  model: CardFieldState
  fallback: CardFieldState
  timeoutMs: CardFieldState
  maxOutputTokens: CardFieldState
  maxExcerptChars: CardFieldState
  instructions: CardFieldState
}

/** The registration-side face the card's slot entry injects. */
export interface ApprovalAdversaryCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useApprovalAdversaryCard. */
    approvalAdversaryCard: SnapshotStore<ApprovalAdversaryCardState>
  }
}

/** Bridges the `approval-adversary` scope onto the card's staged form. */
export class ApprovalAdversaryCardController {
  private readonly form: CardForm<ApprovalAdversarySettings>
  private readonly store: SnapshotStore<ApprovalAdversaryCardState>

  /** @param scope - the bound settings scope for the `approval-adversary` namespace. */
  constructor(scope: SettingsScope<ApprovalAdversarySettings>) {
    this.form = new CardForm(scope, [
      booleanField('enabled'),
      textField('provider'),
      textField('model'),
      textField('fallback'),
      numberField('timeoutMs'),
      numberField('maxOutputTokens'),
      numberField('maxExcerptChars'),
      textField('instructions'),
    ])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): ApprovalAdversaryCardState {
    const shell = this.form.shell()
    const provider = this.form.field('provider')
    const model = this.form.field('model')
    const incompleteRoute = (provider.text.trim() === '') !== (model.text.trim() === '')
    return {
      ...shell,
      invalid: shell.invalid || incompleteRoute,
      enabled: this.form.field('enabled'),
      provider: { ...provider, invalid: provider.invalid || incompleteRoute },
      model: { ...model, invalid: model.invalid || incompleteRoute },
      fallback: this.form.field('fallback'),
      timeoutMs: this.form.field('timeoutMs'),
      maxOutputTokens: this.form.field('maxOutputTokens'),
      maxExcerptChars: this.form.field('maxExcerptChars'),
      instructions: this.form.field('instructions'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): ApprovalAdversaryCardFace {
    return { hooks: { approvalAdversaryCard: this.store }, ...this.form.actions() }
  }
}
