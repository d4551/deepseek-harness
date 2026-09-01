/**
 * The Host model-catalog face both model-selection card specs drive, built as
 * a complete `ModelCatalog` so a spec cannot pass a value the Host never sends.
 */

import { vi } from 'vitest'
import type {
  ClientRemote, ModelCatalog, ModelCatalogFailure, ModelProviderGroup, ModelSelection,
} from '@deepseek-ai/dsh-api-remotes/client'

/** What a card controller reads from the Host session face. */
type CatalogApi = Pick<ClientRemote['session'], 'modelCatalog'>

/** What the stubbed directory answers with. */
export interface ModelCatalogStubOptions {
  /** Provider groups the directory advertises. */
  groups?: readonly ModelProviderGroup[]
  /** Provider-local failures reported beside the groups that answered. */
  failures?: readonly ModelCatalogFailure[]
  /** Route the Host reports as the current default. */
  fallback?: ModelSelection
  /** Failure message; when present the whole request fails instead of answering. */
  error?: string
}

/** A stubbed directory plus the spy standing behind it. */
export interface ModelCatalogStub {
  /** The face handed to the controller under test. */
  api: CatalogApi
  /** Spy behind `modelCatalog`, for call-count assertions. */
  models: ReturnType<typeof vi.fn>
}

/**
 * Build a Host model-catalog face that answers with one fixed directory.
 * @param options - The groups, failures, default route, or failure to answer with.
 * @returns The face and its spy.
 */
export function modelCatalogStub(options: ModelCatalogStubOptions = {}): ModelCatalogStub {
  const groups = options.groups ?? []
  const fallback = options.fallback ?? { provider: 'alpha', model: 'fast' }
  const catalog: ModelCatalog = {
    default: fallback,
    routableProviders: groups.map(group => group.id),
    groups,
    failures: options.failures ?? [],
  }
  const models = vi.fn((): ReturnType<CatalogApi['modelCatalog']> => Promise.resolve(
    options.error === undefined
      ? { ok: true, value: catalog }
      : { ok: false, error: { code: 'internal', message: options.error, details: {} } },
  ))
  return { api: { modelCatalog: models }, models }
}
