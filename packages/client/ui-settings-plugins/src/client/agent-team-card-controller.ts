/** The Agent Team card's staged form over the `agent-team` settings namespace. */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { numberField } from './card-field-spec.ts'

/**
 * Namespace of the Team's user-owned settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const AGENT_TEAM_NS = 'agent-team'

/**
 * The Team fields this card edits — the two capacities the Host section
 * carries. Message budgets, the disposal deadline, and the coordination mode
 * are composition fields and are deliberately absent from the section.
 */
export interface AgentTeamSettings {
  /** Maximum teammates one Team may hold. */
  maxMembers?: number
  /** Maximum open tasks the shared board may hold. */
  maxTasks?: number
}

/** What the Agent Team card renders. */
export interface AgentTeamCardState extends CardShell {
  /** Teammate capacity. */
  maxMembers: CardFieldState
  /** Task-board capacity. */
  maxTasks: CardFieldState
}

/** The registration-side face the Agent Team card's slot entry injects. */
export interface AgentTeamCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useAgentTeamCard. */
    agentTeamCard: SnapshotStore<AgentTeamCardState>
  }
}

/** Bridges the `agent-team` scope onto the card's staged form. */
export class AgentTeamCardController {
  private readonly form: CardForm<AgentTeamSettings>
  private readonly store: SnapshotStore<AgentTeamCardState>

  /** @param scope - the bound settings scope for the `agent-team` namespace. */
  constructor(scope: SettingsScope<AgentTeamSettings>) {
    this.form = new CardForm(scope, [numberField('maxMembers'), numberField('maxTasks')])
    this.store = this.form.bind(() => this.projection())
  }

  private projection(): AgentTeamCardState {
    return {
      ...this.form.shell(),
      maxMembers: this.form.field('maxMembers'),
      maxTasks: this.form.field('maxTasks'),
    }
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): AgentTeamCardFace {
    return { hooks: { agentTeamCard: this.store }, ...this.form.actions() }
  }
}
