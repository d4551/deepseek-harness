/**
 * The web-access card's staged form over the `web` settings namespace: which
 * backend serves `web_search` and which serves `web_fetch`.
 *
 * The seam owns the selection, so this card writes the ids into the seam's own
 * section. What it may offer comes from a second Host fact: the settings
 * describe document, whose served namespaces are exactly the backend plugins
 * this deployment mounted. A catalogued backend the document does not serve is
 * still listed — as one this deployment did not mount — because a backend a
 * user cannot see is a backend they cannot ask for.
 */

import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsDescribeFace, SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { CardForm, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'
import { textField } from './card-field-spec.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import { webProvidersFor, type WebCapability, type WebProviderSpec } from './web-provider-catalog.ts'

/**
 * Namespace of the web seam's own selection settings. Spelled here rather than
 * imported: a client package must not depend on a Host package.
 */
export const WEB_ACCESS_NS = 'web'

/** Section field pinning the search backend. */
const SEARCH_FIELD = 'searchProvider'

/** Section field pinning the fetch backend. */
const FETCH_FIELD = 'fetchProvider'

/** The selection fields this card edits. */
export interface WebAccessSettings {
  /** Provider id serving `web_search`; absent lets the seam auto-select. */
  searchProvider?: string
  /** Provider id serving `web_fetch`; absent lets the seam auto-select. */
  fetchProvider?: string
}

/** One backend as the card offers it. */
export interface WebProviderChoice {
  /** Provider id written into the section. */
  id: string
  /** Locale key of the backend's display name. */
  titleKey: PluginsSettingsLocaleKey
  /** Locale key of the line describing what the backend does. */
  descriptionKey: PluginsSettingsLocaleKey
  /** Plugin package name, named in the line that mounts an unmounted backend. */
  moduleName: string
  /** Whether this deployment mounted the backend; an unmounted one cannot be picked. */
  mounted: boolean
  /** Whether the staged selection names this backend. */
  selected: boolean
}

/** One half of the seam as the card renders it. */
export interface WebCapabilityState {
  /** The staged field, so the card can mark and reset an override. */
  field: CardFieldState
  /** Every catalogued backend for this capability, mounted first. */
  choices: readonly WebProviderChoice[]
  /**
   * True when nothing is pinned, which leaves the seam to auto-select — it
   * serves only while exactly one mounted backend is usable, and refuses
   * otherwise, so the card says so rather than showing an empty selection.
   */
  automatic: boolean
}

/** What the web-access card renders. */
export interface WebAccessCardState extends CardShell {
  /** The backend serving `web_search`. */
  search: WebCapabilityState
  /** The backend serving `web_fetch`. */
  fetch: WebCapabilityState
  /**
   * True when the rendering fetch backend is mounted and selected but the Host
   * confirmed no browser for it, which is the one state in which `web_fetch`
   * is configured, looks configured, and cannot serve.
   */
  browserMissing: boolean
}

/** The registration-side face the web-access card's slot entry injects. */
export interface WebAccessCardFace extends CardActions {
  hooks: {
    /** Card snapshot bound by the renderer as useWebAccessCard. */
    webAccessCard: SnapshotStore<WebAccessCardState>
  }
}

/** Binds the `web` scope and the served-namespace directory onto the card. */
export class WebAccessCardController {
  private readonly form: CardForm<WebAccessSettings>
  private readonly store: SnapshotStore<WebAccessCardState>
  private disposed = false
  private readonly unsubscribe: () => void
  /**
   * Settlement chain of the mirror read this controller started, so a caller
   * can await the directory instead of polling the hook.
   */
  mirrorChain: Promise<void> = Promise.resolve()

  /**
   * @param scope - the bound settings scope for the `web` namespace.
   * @param describeFace - the shared mirror's describe face; its served
   * namespaces are the backends this deployment mounted.
   */
  constructor(
    scope: SettingsScope<WebAccessSettings>,
    private readonly describeFace: SettingsDescribeFace,
  ) {
    this.form = new CardForm(scope, [textField(SEARCH_FIELD), textField(FETCH_FIELD)])
    this.store = this.form.bind(() => this.projection())
    this.unsubscribe = describeFace.subscribe(() => { this.publish() })
    this.mirrorChain = describeFace.ensure()
  }

  /** Stop following the served-namespace directory. */
  dispose(): void {
    this.disposed = true
    this.unsubscribe()
  }

  /**
   * Build the face the card's slot registration injects.
   * @returns the card's snapshot and its form actions.
   */
  inject(): WebAccessCardFace {
    return { hooks: { webAccessCard: this.store }, ...this.form.actions() }
  }

  /** Republish after the served set moved; the staged form publishes itself. */
  private publish(): void {
    if (this.disposed) return
    this.store.set(this.projection())
  }

  private projection(): WebAccessCardState {
    return {
      ...this.form.shell(),
      search: this.capability('search', SEARCH_FIELD),
      fetch: this.capability('fetch', FETCH_FIELD),
      browserMissing: this.browserMissing(),
    }
  }

  private capability(capability: WebCapability, field: string): WebCapabilityState {
    const state = this.form.field(field)
    const served = this.servedNamespaces()
    const choices = webProvidersFor(capability)
      .map(provider => this.choiceOf(provider, served, state.text))
      // A backend this deployment mounted is one the user can pick now; an
      // unmounted one is a composition change, so it sorts after.
      .sort((left, right) => Number(right.mounted) - Number(left.mounted))
    return { field: state, choices, automatic: state.text === '' }
  }

  private choiceOf(
    provider: WebProviderSpec,
    served: ReadonlySet<string>,
    staged: string,
  ): WebProviderChoice {
    return {
      id: provider.providerId,
      titleKey: provider.titleKey,
      descriptionKey: provider.descriptionKey,
      moduleName: provider.moduleName,
      mounted: served.has(provider.ns),
      selected: staged === provider.providerId,
    }
  }

  /** Namespaces the Host currently serves; empty until the first answer lands. */
  private servedNamespaces(): ReadonlySet<string> {
    return new Set(this.describeFace.getSnapshot().view?.namespaces.map(view => view.ns) ?? [])
  }

  /**
   * Whether a selected rendering backend has no browser behind it. The
   * composition layer of the rendering backend's own section carries the
   * executable the Host confirmed at mount, so its absence there — while the
   * namespace is served — is the deployment reporting that it found none.
   */
  private browserMissing(): boolean {
    const rendering = webProvidersFor('fetch').find(provider => provider.browserField !== undefined)
    if (rendering === undefined) return false
    const selected = this.form.field(FETCH_FIELD).text
    if (selected !== rendering.providerId) return false
    const view = this.describeFace.getSnapshot().view?.namespaces.find(entry => entry.ns === rendering.ns)
    if (view === undefined) return false
    const base = view.base
    if (typeof base !== 'object' || base === null || Array.isArray(base)) return true
    const confirmed = Reflect.get(base, rendering.browserField as string) as unknown
    return typeof confirmed !== 'string' || confirmed.length === 0
  }
}
