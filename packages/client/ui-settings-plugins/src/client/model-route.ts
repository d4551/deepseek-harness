/** One provider/model route and the catalog join both model-selection cards read. */

import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'

/**
 * Adapter-directory request state. `idle` is the state before the first
 * request and after an invalidation, so a card knows to open one.
 */
export type ModelCatalogStatus = 'idle' | 'loading' | 'ready' | 'error'

/** One exact provider/model route as stored in a settings document. */
export interface ModelRoute {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
}

/** One catalog row joined with a stored route that may no longer be advertised. */
export interface ModelRouteCandidate extends ModelRoute {
  /** Stable opaque identity used only for lookup. */
  key: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Adapter-owned model display name. */
  modelName: string
  /** Whether the current adapter catalog advertises this exact route. */
  available: boolean
  /** Whether the current draft selects this route. */
  selected: boolean
}

/** Advertised routes of one provider, in catalog order. */
export interface ModelRouteGroup {
  /** Registered provider route the rows share. */
  provider: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Rows the catalog advertises for this provider. */
  candidates: readonly ModelRouteCandidate[]
}

/** Catalog rows split into the provider groups and the stored-but-absent rows. */
export interface GroupedModelRouteCandidates {
  /** Advertised rows grouped by provider, in first-seen order. */
  available: readonly ModelRouteGroup[]
  /** Stored rows the catalog no longer advertises, in stored order. */
  unavailable: readonly ModelRouteCandidate[]
}

/**
 * Stable identity for one exact route; callers resolve it by lookup and never
 * parse it.
 *
 * Each id is backslash-escaped before joining, so a NUL inside one id can
 * never impersonate the separator and no pair of distinct routes collides,
 * even for an id a malformed source let carry one. The key is in-memory card
 * state only: nothing persists it, so a later encoding change needs no
 * migration.
 * @param route - Provider/model route to identify.
 * @returns Opaque key for lookup within a card.
 */
export function modelRouteKey(route: ModelRoute): string {
  const escaped = (id: string): string => id.replaceAll('\\', '\\\\').replaceAll('\0', '\\0')
  return `${escaped(route.provider)}\0${escaped(route.model)}`
}

/**
 * Join live adapter metadata with stored routes that stay removable after they
 * disappear from the catalog.
 * @param groups - Current model directory grouped by provider.
 * @param stored - Routes in the effective settings value.
 * @param selected - Opaque route keys selected in the current draft.
 * @returns Candidate rows in catalog order, then the stored rows the catalog omits.
 */
export function modelRouteCandidates(
  groups: readonly ModelProviderGroup[],
  stored: readonly ModelRoute[],
  selected: ReadonlySet<string>,
): ModelRouteCandidate[] {
  const storedByKey = new Map(stored.map(route => [modelRouteKey(route), route]))
  const candidates = groups.flatMap(group => group.models.map((model): ModelRouteCandidate => {
    const key = modelRouteKey({ provider: group.id, model: model.id })
    storedByKey.delete(key)
    return {
      provider: group.id,
      model: model.id,
      key,
      providerName: group.name,
      modelName: model.name,
      available: true,
      selected: selected.has(key),
    }
  }))
  for (const route of storedByKey.values()) {
    const key = modelRouteKey(route)
    candidates.push({
      provider: route.provider,
      model: route.model,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: selected.has(key),
    })
  }
  return candidates
}

/**
 * Split candidate rows into the per-provider groups a card lists and the
 * stored rows it lists apart because the catalog no longer advertises them.
 * @param candidates - Rows joined by `modelRouteCandidates`.
 * @returns The provider groups and the unavailable rows.
 */
export function groupModelRouteCandidates(
  candidates: readonly ModelRouteCandidate[],
): GroupedModelRouteCandidates {
  const available = new Map<string, { providerName: string; candidates: ModelRouteCandidate[] }>()
  const unavailable: ModelRouteCandidate[] = []
  for (const candidate of candidates) {
    if (!candidate.available) {
      unavailable.push(candidate)
      continue
    }
    const group = available.get(candidate.provider)
    if (group === undefined) {
      available.set(candidate.provider, {
        providerName: candidate.providerName,
        candidates: [candidate],
      })
    } else group.candidates.push(candidate)
  }
  return {
    available: [...available].map(([provider, group]) => ({ provider, ...group })),
    unavailable,
  }
}
