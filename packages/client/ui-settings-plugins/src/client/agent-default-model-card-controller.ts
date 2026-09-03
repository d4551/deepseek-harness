/** Staged editor for the Host-owned default model selection. */

import type { AgentDefaultModelSettings, ClientRemote } from '@deepseek-ai/dsh-api-remotes/client'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-session-controller/types'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'
import {
  modelRouteCandidates, modelRouteKey,
  type ModelCatalogStatus, type ModelRoute, type ModelRouteCandidate,
} from './model-route.ts'

/** Namespace of the Host-owned default model preference. */
export const AGENT_DEFAULT_MODEL_NS = 'agent-default-model'

/** State rendered by the staged default-model card. */
export interface AgentDefaultModelCardState extends CardShell {
  /** Live catalog joined with the stored route. */
  candidates: readonly ModelRouteCandidate[]
  /** Model-directory request state. */
  catalogStatus: ModelCatalogStatus
  /** Whether any provider-local catalog request failed. */
  catalogPartial: boolean
  /** Whether a newer Host revision invalidated the current draft. */
  conflicted: boolean
}

/** Registration-side face for the default-model card. */
export interface AgentDefaultModelCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useAgentDefaultModelCard. */
    agentDefaultModelCard: SnapshotStore<AgentDefaultModelCardState>
  }
  /** Stage one exact route as the default; reports whether the draft took it. */
  selectModel: (key: string) => boolean
  /** Retry the model directory; resolves to whether the catalog answered. */
  retryCatalog: () => Promise<boolean>
  /** Persist the staged route as one revision-fenced mutation. */
  save: () => Promise<boolean>
  /** Drop the staged route; reports whether a draft was dropped. */
  discard: () => boolean
}

/** Follows one settings scope and the live model directory onto a staged card. */
export class AgentDefaultModelCardController {
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogPartial = false
  private catalogStatus: ModelCatalogStatus = 'idle'
  private draftRoute: ModelRoute | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  /**
   * Settlement chain of the latest backgrounded catalog or save run, so a
   * caller can await the run instead of polling the snapshot.
   */
  background: Promise<boolean> = Promise.resolve(false)
  private readonly store: SnapshotStore<AgentDefaultModelCardState>

  /** Wrapped settings-scope disposer; returns true when it ran. */
  private readonly disposers: readonly (() => boolean)[]

  /**
   * @param scope - bound `agent-default-model` settings scope.
   * @param session - Host Session model-catalog face.
   */
  constructor(
    private readonly scope: SettingsScope<AgentDefaultModelSettings>,
    private readonly session: Pick<ClientRemote['session'], 'modelCatalog'>,
  ) {
    this.store = createSnapshotStore(this.projection())
    const stopFollowing = scope.subscribe(() => {
      if (!this.saving && this.draftRoute !== undefined
        && this.scope.getSnapshot().revision !== this.draftRevision) {
        if (this.routeKey(this.currentRoute()) === this.routeKey(this.desiredRoute())) this.clearDraft()
        else this.conflicted = true
      }
      this.publish()
    })
    this.disposers = [() => {
      stopFollowing()
      return true
    }]
    this.background = this.loadCatalog()
  }

  /** Stop observing settings and suppress late directory/write settlements. */
  dispose() {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    for (const dispose of this.disposers) dispose()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): AgentDefaultModelCardFace {
    return {
      hooks: { agentDefaultModelCard: this.store },
      selectModel: key => this.selectModel(key),
      retryCatalog: () => this.loadCatalog(),
      save: () => this.persist(),
      discard: () => this.discard(),
    }
  }

  private currentRoute(): ModelRoute | undefined {
    const value = this.scope.getSnapshot().value
    return value === undefined ? undefined : { provider: value.provider, model: value.model }
  }

  /**
   * Key of a route the card may not hold; an absent route keys to absent so
   * two absences compare equal and an absence never equals a stored route.
   */
  private routeKey(route: ModelRoute | undefined): string | undefined {
    return route === undefined ? undefined : modelRouteKey(route)
  }

  private beginDraft() {
    if (this.draftRoute === undefined) {
      this.draftRoute = this.currentRoute()
      this.draftRevision = this.scope.getSnapshot().revision
    }
  }

  private selectModel(key: string): boolean {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return false
    const candidate = this.candidates().find(candidate => candidate.key === key)
    if (candidate === undefined) return false
    this.beginDraft()
    this.draftRoute = { provider: candidate.provider, model: candidate.model }
    this.failed = false
    this.publish()
    return true
  }

  private clearDraft() {
    this.draftRoute = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private discard(): boolean {
    if (this.saving) return false
    this.clearDraft()
    this.publish()
    return true
  }

  private candidates(): ModelRouteCandidate[] {
    const desired = this.desiredRoute()
    const key = this.routeKey(desired)
    return modelRouteCandidates(
      this.catalogGroups,
      desired === undefined ? [] : [desired],
      key === undefined ? new Set<string>() : new Set([key]),
    )
  }

  private desiredRoute(): ModelRoute | undefined {
    return this.draftRoute ?? this.currentRoute()
  }

  private async persist(): Promise<boolean> {
    const snapshot = this.scope.getSnapshot()
    const desired = this.desiredRoute()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving
      || desired === undefined
      || this.routeKey(this.currentRoute()) === modelRouteKey(desired)) return false
    if (this.draftRoute !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return false
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    // A route switch makes any reasoning effort stored for the previous model
    // stale, so the save unsets it and the model answers with its own.
    await this.scope.mutate([
      { op: 'set', path: ['provider'], value: desired.provider },
      { op: 'set', path: ['model'], value: desired.model },
      { op: 'unset', path: ['reasoningEffort'] },
    ], this.draftRevision)
    if (generation !== this.saveGeneration) return false
    const current = this.currentRoute()
    const landed = current !== undefined && modelRouteKey(current) === modelRouteKey(desired)
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
    return landed
  }

  /** Invalidate and reload model candidates after a Host model input changes. */
  refreshCatalog() {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    this.background = this.loadCatalog()
  }

  /** Drop Host-specific candidates and drafts, then reload after reconnecting. */
  resetConnection() {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.clearDraft()
    this.catalogGroups = []
    this.refreshCatalog()
  }

  private async loadCatalog(): Promise<boolean> {
    if (this.disposed || this.catalogStatus === 'loading') return false
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const response = await this.session.modelCatalog()
    if (generation !== this.catalogGeneration) return false
    if (response.ok) {
      this.catalogGroups = response.value.groups
      this.catalogPartial = response.value.failures.length > 0
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
    return response.ok
  }

  private projection(): AgentDefaultModelCardState {
    const snapshot = this.scope.getSnapshot()
    const current = this.currentRoute()
    const desired = this.desiredRoute()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: current === undefined
        ? desired !== undefined
        : desired === undefined || modelRouteKey(current) !== modelRouteKey(desired),
      invalid: false,
      saving: this.saving,
      failed: this.failed,
      candidates: this.candidates(),
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      conflicted: this.conflicted,
    }
  }

  private publish() {
    this.store.set(this.projection())
  }
}
