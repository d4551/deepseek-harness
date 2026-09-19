/**
 * Permission default-settings controller. The permission descriptor comes
 * from the shared describe mirror (the dynamic preset enum lives in the
 * namespace schema, which per-namespace scopes do not carry); writes target
 * only `defaultPreset`, carry the descriptor revision, and fold their answer
 * back into the mirror.
 */

import type { SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  createSnapshotStore, type SnapshotStore,
} from '@deepseek-ai/dsh-client-store'
import type {
  SchemaNode, SettingsDescribeFace, SettingsSchemaService, SettingsWireFace,
} from '@deepseek-ai/dsh-client-ui-settings/client'

/** Permission's settings namespace on the host wire. */
export const PERMISSION_SETTINGS_NS = 'permission'

/** Values a throw or Promise rejection can carry. */
type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

function thrownMessage(reason: Thrown): string {
  if (reason instanceof Error) return reason.message
  return String(reason)
}

/** One selectable new-session default. */
export interface PermissionDefaultOption {
  /** Preset key written to Settings. */
  id: string
  /** Host-supplied label or a title-cased preset key. */
  name: string
}

/** Permission settings-row snapshot. */
export interface PermissionSettingsState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'unavailable' | 'error'
  error: string | null
  writable: boolean
  currentValue: string
  options: readonly PermissionDefaultOption[]
  revision: number
}

/** Claimed defaultPreset enum, or the reason the descriptor cannot be shown. */
type PermissionDefaultClaim =
  | { readonly currentValue: string; readonly options: PermissionDefaultOption[] }
  | { readonly error: string }

/**
 * Read the current defaultPreset string off a namespace value.
 * @param value - redacted namespace value.
 * @returns the preset key, or undefined when the field is absent or not a string.
 */
function defaultPresetOf(value: unknown): string | undefined {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  if (!('defaultPreset' in value) || typeof value.defaultPreset !== 'string') return undefined
  return value.defaultPreset
}

/**
 * Enumerate selectable const members of a defaultPreset schema node.
 * @param node - rehydrated defaultPreset field.
 * @returns the union members, or the node itself when it is not a union.
 */
function schemaChoicesOf(node: SchemaNode): readonly SchemaNode[] {
  if (node.type !== 'union') return [node]
  return node.list ?? []
}

/**
 * Claim one const schema member as a selectable option.
 * @param candidate - union member or standalone const node.
 * @returns a one-element option list, or empty when the member is not a string const.
 */
function choiceOptionOf(candidate: SchemaNode): PermissionDefaultOption[] {
  if (candidate.type !== 'const' || typeof candidate.value !== 'string') return []
  const described = candidate.meta.description
  return [{
    id: candidate.value,
    name: typeof described === 'string' && described.length > 0 ? described : candidate.value,
  }]
}

/**
 * Claim the dynamic preset enum encoded by the host's `defaultPreset` schema.
 * @param view - permission namespace descriptor.
 * @param schema - settings schema operations.
 * @returns current value and options, or the reason the descriptor is unusable.
 */
function permissionDefaultClaim(
  view: SettingsNamespaceView,
  schema: SettingsSchemaService,
): PermissionDefaultClaim {
  const currentValue = defaultPresetOf(view.value)
  if (currentValue === undefined) return { error: 'permission settings has no defaultPreset value' }
  const node = schema.nodeAtPath(schema.rehydrate(view.schema), ['defaultPreset'])
  if (node === undefined) return { error: 'permission settings schema has no defaultPreset field' }
  const options = schemaChoicesOf(node).flatMap(choiceOptionOf)
  if (options.length === 0 || !options.some(option => option.id === currentValue)) {
    return { error: 'permission settings schema does not advertise its current preset' }
  }
  return { currentValue, options }
}

/**
 * Read the dynamic preset enum encoded by the host's `defaultPreset` schema.
 * @param view - permission namespace descriptor.
 * @param schema - settings schema operations.
 * @returns current value and selectable options.
 */
export function permissionDefaultOf(view: SettingsNamespaceView, schema: SettingsSchemaService): {
  currentValue: string
  options: PermissionDefaultOption[]
} {
  const claimed = permissionDefaultClaim(view, schema)
  if ('error' in claimed) throw new Error(claimed.error)
  return { currentValue: claimed.currentValue, options: claimed.options }
}

/** Controller deriving the row from the shared mirror and writing the default through it. */
export class PermissionPresetSettingsController {
  /** Row snapshot consumed through a bound selector hook. */
  readonly store: SnapshotStore<PermissionSettingsState> = createSnapshotStore({
    status: 'idle',
    error: null,
    writable: false,
    currentValue: '',
    options: [],
    revision: 0,
  })

  private following: (() => void) | undefined
  private saving = false
  private disposed = false

  /**
   * @param describeFace - the shared mirror's read/fold face (descriptor and schema source).
   * @param api - settings wire face for the `defaultPreset` write.
   * @param schema - settings-owned schema operations.
   */
  constructor(
    private readonly describeFace: SettingsDescribeFace,
    private readonly api: SettingsWireFace,
    private readonly schema: SettingsSchemaService,
  ) {}

  /**
   * Begin following the mirror (idempotent) and reflect its current answer.
   * @returns settlement once the snapshot reflects the mirror.
   */
  async load(): Promise<void> {
    if (this.disposed) return
    this.following ??= this.describeFace.subscribe(() => { this.derive() })
    this.store.update((state) => {
      state.status = 'loading'
      state.error = null
    })
    await this.describeFace.ensure()
    this.derive()
  }

  /**
   * Persist one preset as the default for subsequently created sessions.
   * A selection made while one is already saving is ignored — the row's
   * control is disabled during the save, so this only drops programmatic
   * double-submits rather than user intent.
   * @param preset - advertised preset key.
   * @returns nothing; {@link store} carries success or failure.
   */
  async select(preset: string): Promise<void> {
    const state = this.store.getSnapshot()
    const view = this.describeFace.getSnapshot().view?.namespaces
      .find(entry => entry.ns === PERMISSION_SETTINGS_NS)
    if (view === undefined || !state.writable || this.saving) return
    this.saving = true
    this.store.update((draft) => {
      draft.status = 'saving'
      draft.error = null
    })
    using _clearSaving = {
      [Symbol.dispose]: (): void => {
        this.saving = false
      },
    }
    const flight = this.api.settings.mutate(
      PERMISSION_SETTINGS_NS,
      [{ op: 'set', path: ['defaultPreset'], value: preset }],
      view.revision,
    )
    flight.then(
      undefined,
      (error: Thrown) => {
        if (this.disposed) return
        this.fail(thrownMessage(error))
      },
    )
    const response = await flight
    if (this.disposed) return
    if (!response.ok) {
      this.fail(response.error.message)
      return
    }
    this.saving = false
    this.describeFace.acceptView(response.value)
  }

  /** Stop following the mirror; later publishes leave the snapshot alone. */
  dispose(): void {
    this.disposed = true
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.disposed || this.saving) return
    const mirrored = this.describeFace.getSnapshot()
    if (mirrored.status === 'unavailable') {
      // The terminal non-loopback state: this client keeps Host persistence disabled, so
      // the row hides itself exactly like an unserved namespace.
      this.store.update((state) => {
        state.status = 'unavailable'
        state.writable = false
        state.currentValue = ''
        state.options = []
      })
      return
    }
    if (mirrored.view === undefined) {
      // A held failure with no answer is a failed row; without one the read
      // is still in flight and the row keeps its loading state.
      if (mirrored.error !== null) this.fail(mirrored.error)
      return
    }
    const view = mirrored.view.namespaces.find(entry => entry.ns === PERMISSION_SETTINGS_NS)
    if (view === undefined) {
      this.store.update((state) => {
        state.status = 'unavailable'
        state.writable = false
        state.currentValue = ''
        state.options = []
      })
      return
    }
    const claimed = permissionDefaultClaim(view, this.schema)
    if ('error' in claimed) {
      this.fail(claimed.error)
      return
    }
    const { writable } = mirrored.view
    this.store.update((state) => {
      state.status = 'ready'
      state.error = null
      state.writable = writable
      state.currentValue = claimed.currentValue
      state.options = claimed.options
      state.revision = view.revision
    })
  }

  private fail(message: string): void {
    this.store.update((state) => {
      state.status = 'error'
      state.error = message
    })
  }
}
