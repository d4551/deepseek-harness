/**
 * The web backends this Client knows how to name, and how each one appears in
 * Settings.
 *
 * Two Host facts meet here. A backend's settings NAMESPACE is what the Host
 * serves once the deployment mounts its plugin, so the served set is the
 * mounted set. A backend's PROVIDER ID is what the `web` seam's
 * `searchProvider` / `fetchProvider` fields name, so the pin is written in
 * those ids. The pair is spelled here rather than imported: a client package
 * must not depend on a Host package.
 *
 * A catalog entry the Host does not serve is still rendered — as a backend
 * this deployment did not mount, with the composition line that mounts it.
 * A package nobody can discover is the defect this catalog exists to prevent.
 */

import type { PluginsSettingsLocaleKey } from './locales.ts'

/** Which half of the web seam one backend serves. */
export type WebCapability = 'search' | 'fetch'

/** How one section field is edited and labelled. */
export interface WebProviderFieldSpec {
  /** Field name inside the namespace section. */
  field: string
  /** Which control and conversion this field uses. */
  kind: 'text' | 'number' | 'secret'
  /** Locale key of the field's visible label. */
  labelKey: PluginsSettingsLocaleKey
  /** Locale key of the one-line explanation under the control. */
  hintKey: PluginsSettingsLocaleKey
}

/** One web backend as Settings renders it. */
export interface WebProviderSpec {
  /** Settings namespace the owning Host plugin registers. */
  ns: string
  /** Provider id the `web` seam's selection fields name. */
  providerId: string
  /** Which half of the seam this backend serves. */
  capability: WebCapability
  /** Plugin package name, so an unmounted backend can be named in a composition line. */
  moduleName: string
  /** Locale key of the backend's display name. */
  titleKey: PluginsSettingsLocaleKey
  /** Locale key of the line describing what the backend does. */
  descriptionKey: PluginsSettingsLocaleKey
  /** The section fields this backend's card edits. */
  fields: readonly WebProviderFieldSpec[]
  /**
   * Field whose COMPOSITION layer carries the browser executable the Host
   * confirmed at mount. Its absence there is the deployment's statement that no
   * browser installation was found, which is the one condition under which this
   * backend is mounted, selected, and still unable to serve.
   */
  browserField?: string
}

/** Exa's section fields. */
const EXA_FIELDS: readonly WebProviderFieldSpec[] = [
  { field: 'apiKey', kind: 'secret', labelKey: 'webApiKey', hintKey: 'webSearchExaApiKeyHint' },
  { field: 'baseURL', kind: 'text', labelKey: 'webBaseUrl', hintKey: 'webBaseUrlHint' },
  { field: 'searchType', kind: 'text', labelKey: 'webSearchExaType', hintKey: 'webSearchExaTypeHint' },
  { field: 'numResults', kind: 'number', labelKey: 'webSearchExaNumResults', hintKey: 'webSearchExaNumResultsHint' },
  {
    field: 'highlightsPerResult',
    kind: 'number',
    labelKey: 'webSearchExaHighlights',
    hintKey: 'webSearchExaHighlightsHint',
  },
]

/** Perplexity's section fields. */
const PERPLEXITY_FIELDS: readonly WebProviderFieldSpec[] = [
  { field: 'apiKey', kind: 'secret', labelKey: 'webApiKey', hintKey: 'webSearchPerplexityApiKeyHint' },
  { field: 'baseURL', kind: 'text', labelKey: 'webBaseUrl', hintKey: 'webBaseUrlHint' },
  { field: 'model', kind: 'text', labelKey: 'webSearchPerplexityModel', hintKey: 'webSearchPerplexityModelHint' },
  { field: 'maxTokens', kind: 'number', labelKey: 'webMaxTokens', hintKey: 'webSearchPerplexityMaxTokensHint' },
  {
    field: 'searchRecency',
    kind: 'text',
    labelKey: 'webSearchPerplexityRecency',
    hintKey: 'webSearchPerplexityRecencyHint',
  },
]

/** The HTTP fetch backend's section fields. */
const HTTP_FIELDS: readonly WebProviderFieldSpec[] = [
  { field: 'maxResponseBytes', kind: 'number', labelKey: 'webFetchMaxResponseBytes', hintKey: 'webFetchMaxResponseBytesHint' },
  { field: 'maxBodyChars', kind: 'number', labelKey: 'webFetchMaxBodyChars', hintKey: 'webFetchMaxBodyCharsHint' },
  { field: 'timeoutMs', kind: 'number', labelKey: 'webFetchTimeoutMs', hintKey: 'webFetchTimeoutMsHint' },
  { field: 'maxRedirects', kind: 'number', labelKey: 'webFetchMaxRedirects', hintKey: 'webFetchMaxRedirectsHint' },
  { field: 'userAgent', kind: 'text', labelKey: 'webFetchUserAgent', hintKey: 'webFetchUserAgentHint' },
]

/** The rendering fetch backend's section fields. */
const PLAYWRIGHT_FIELDS: readonly WebProviderFieldSpec[] = [
  { field: 'maxBodyChars', kind: 'number', labelKey: 'webFetchMaxBodyChars', hintKey: 'webFetchMaxBodyCharsHint' },
  { field: 'timeoutMs', kind: 'number', labelKey: 'webFetchTimeoutMs', hintKey: 'webFetchTimeoutMsHint' },
  {
    field: 'maxConcurrentRenders',
    kind: 'number',
    labelKey: 'webFetchMaxConcurrentRenders',
    hintKey: 'webFetchMaxConcurrentRendersHint',
  },
  { field: 'userAgent', kind: 'text', labelKey: 'webFetchUserAgent', hintKey: 'webFetchUserAgentHint' },
  { field: 'executablePath', kind: 'text', labelKey: 'webFetchExecutablePath', hintKey: 'webFetchExecutablePathHint' },
]

/**
 * Every web backend this Client can name, in the order Settings lists them.
 * The DeepSeek search backend keeps its own card because its key lives in the
 * credentials domain rather than in its section, so it is catalogued for
 * naming and selection only and declares no fields here.
 */
export const WEB_PROVIDERS: readonly WebProviderSpec[] = [
  {
    ns: 'web-search-deepseek',
    providerId: 'deepseek-official',
    capability: 'search',
    moduleName: '@deepseek-ai/dsh-web-search-deepseek',
    titleKey: 'webSearchTitle',
    descriptionKey: 'webSearchDescription',
    fields: [],
  },
  {
    ns: 'web-search-exa',
    providerId: 'exa',
    capability: 'search',
    moduleName: '@deepseek-ai/dsh-web-search-exa',
    titleKey: 'webSearchExaTitle',
    descriptionKey: 'webSearchExaDescription',
    fields: EXA_FIELDS,
  },
  {
    ns: 'web-search-perplexity',
    providerId: 'perplexity',
    capability: 'search',
    moduleName: '@deepseek-ai/dsh-web-search-perplexity',
    titleKey: 'webSearchPerplexityTitle',
    descriptionKey: 'webSearchPerplexityDescription',
    fields: PERPLEXITY_FIELDS,
  },
  {
    ns: 'web-fetch-http',
    providerId: 'http',
    capability: 'fetch',
    moduleName: '@deepseek-ai/dsh-web-fetch-http',
    titleKey: 'webFetchHttpTitle',
    descriptionKey: 'webFetchHttpDescription',
    fields: HTTP_FIELDS,
  },
  {
    ns: 'web-fetch-playwright',
    providerId: 'playwright',
    capability: 'fetch',
    moduleName: '@deepseek-ai/dsh-web-fetch-playwright',
    titleKey: 'webFetchPlaywrightTitle',
    descriptionKey: 'webFetchPlaywrightDescription',
    fields: PLAYWRIGHT_FIELDS,
    browserField: 'executablePath',
  },
]

/**
 * The catalogued backends serving one half of the seam.
 * @param capability - which half of the seam to list.
 * @returns the backends for that capability, in catalog order.
 */
export function webProvidersFor(capability: WebCapability): readonly WebProviderSpec[] {
  return WEB_PROVIDERS.filter(provider => provider.capability === capability)
}
