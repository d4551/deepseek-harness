/**
 * One web backend's staged form over its own settings namespace.
 *
 * Every backend edits the same kinds of value — a key, an endpoint, byte and
 * time budgets — so the card is one component driven by the catalogue's field
 * list rather than five hand-written twins. The controller adds only what the
 * generic form cannot know: which fields exist, and whether the Host confirmed
 * a browser for the backend that needs one.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { numberField, textField, type CardFieldSpec } from './card-field-spec.ts'
import type { WebProviderSpec } from './web-provider-catalog.ts'

/** Section values a web backend's card edits; every field is optional in its schema. */
export type WebProviderSettings = Record<string, unknown>

/** What one web backend's card renders. */
export interface WebProviderCardState extends CardShell {
  /** Each catalogued field's staged control state, keyed by field name. */
  fields: Record<string, CardFieldState>
  /** Whether the Host reports a value for the backend's secret field. */
  secretConfigured: boolean
  /**
   * Whether the Host confirmed a browser executable for this backend, when it
   * declares one. `false` on a served namespace means the deployment found no
   * installation, which is what makes a selected rendering backend unable to
   * serve while looking configured.
   */
  browserConfirmed: boolean
}

/** The registration-side face one web backend's card injects. */
export interface WebProviderCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebProviderCard. */
    webProviderCard: SnapshotStore<WebProviderCardState>
  }
  /** The catalogue entry this card renders. */
  spec: WebProviderSpec
}

/**
 * The conversion spec for one catalogued field. A secret field converts as
 * text: unlike the DeepSeek key, these keys live in the section itself, so a
 * draft stages and clears exactly like any other stored string.
 * @param field - the catalogued field.
 * @returns the form's conversion spec for it.
 */
function specOf(field: WebProviderSpec['fields'][number]): CardFieldSpec {
  return field.kind === 'number' ? numberField(field.field) : textField(field.field)
}

/** Bridges one web backend's scope onto the shared provider card. */
export class WebProviderCardController {
  private readonly form: CardForm<WebProviderSettings>
  private readonly store: SnapshotStore<WebProviderCardState>

  /**
   * @param spec - the catalogue entry naming this backend's namespace and fields.
   * @param scope - the bound settings scope for that namespace.
   */
  constructor(
    private readonly spec: WebProviderSpec,
    private readonly scope: SettingsScope<WebProviderSettings>,
  ) {
    this.form = new CardForm(scope, spec.fields.map(specOf))
    this.store = this.form.bind(() => this.projection())
  }

  /** The settings namespace this card is dispatched under. */
  get namespace(): string {
    return this.spec.ns
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot, its catalogue entry, and its form actions.
   */
  inject(): WebProviderCardFace {
    return { hooks: { webProviderCard: this.store }, spec: this.spec, ...this.form.actions() }
  }

  private projection(): WebProviderCardState {
    const fields: Record<string, CardFieldState> = {}
    for (const field of this.spec.fields) fields[field.field] = this.form.field(field.field)
    return {
      ...this.form.shell(),
      fields,
      secretConfigured: this.secretConfigured(),
      browserConfirmed: this.browserConfirmed(),
    }
  }

  /**
   * Whether the Host holds a value for this backend's secret field. A secret is
   * redacted out of every layer it rides in, so its presence is read from the
   * namespace's declared secret slots rather than from the value.
   */
  private secretConfigured(): boolean {
    const secret = this.spec.fields.find(field => field.kind === 'secret')
    if (secret === undefined) return false
    return this.scope.getSnapshot().secrets.some(slot => slot.path.length === 1
      && slot.path[0] === secret.field
      && slot.set)
  }

  /**
   * Whether the composition layer names the browser the Host confirmed at
   * mount. The Host publishes that field there only after its probe passed, so
   * an absent one is the deployment reporting it found no installation.
   */
  private browserConfirmed(): boolean {
    const { browserField } = this.spec
    if (browserField === undefined) return false
    const base = this.scope.getSnapshot().base
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return false
    const confirmed = Reflect.get(base, browserField) as unknown
    return typeof confirmed === 'string' && confirmed.length > 0
  }
}
