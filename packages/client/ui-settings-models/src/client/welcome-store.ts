/**
 * Welcome-notice state derived from the welcome settings scope. The scope is
 * the transport: a loopback browser follows the durable Host section, while a
 * remote browser's memory-mode scope never answers and the acknowledgement
 * stays process-local here.
 */

import type { JsonValue } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION,
} from '../onboarding-copy.ts'

type Thrown = object | string | number | boolean | bigint | symbol | null | undefined

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true
  if (typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return true
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (typeof value !== 'object') return false
  return Object.values(value).every(isJsonValue)
}

/** State rendered by the welcome step. */
export interface WelcomeNoticeState {
  status: 'idle' | 'loading' | 'ready' | 'saving' | 'error'
  acknowledged: boolean
  error: string | null
}

/** The welcome section as the notice reads it. */
export type WelcomeSection = { [key: string]: JsonValue }

/**
 * Claim a JSON object section. A malformed durable value reads as an empty
 * section, so the notice treats it as unacknowledged instead of leaving the
 * scope stuck on its previous value.
 * @param section - the wire section value.
 * @returns the claimed section, or an empty object for a non-JSON object.
 */
export function decodeWelcomeSection(section: unknown): WelcomeSection {
  if (!isJsonValue(section) || typeof section !== 'object' || section === null || Array.isArray(section)) {
    return {}
  }
  return { ...section }
}

/** Coordinates durable Host acknowledgement or a process-local remote acknowledgement. */
export class WelcomeNoticeStore {
  /** uSES-safe state source shared by the registered welcome step. */
  readonly store: SnapshotStore<WelcomeNoticeState> = createSnapshotStore<WelcomeNoticeState>({
    status: 'idle', acknowledged: false, error: null,
  })

  private localAcknowledged = false
  private saving = false
  private following: (() => void) | undefined

  /**
   * @param scope - the welcome settings namespace scope; its memory mode is
   * what keeps a remote browser process-local.
   */
  constructor(private readonly scope: SettingsScope<WelcomeSection>) {}

  /**
   * Begin following the bound scope (idempotent) and publish its current answer.
   * @returns settlement after the current answer is published.
   */
  load(): Promise<void> {
    this.following ??= this.scope.subscribe(() => { this.derive() })
    this.derive()
    return Promise.resolve()
  }

  /**
   * Persist this copy version, or advance only this process for a remote
   * browser. Success is judged against the state the write left behind, so a
   * refused or failed write reports false after its recovery read settles.
   * @returns true when the selected persistence mode holds the acknowledgement.
   */
  acknowledge(): Promise<boolean> {
    if (this.scope.getSnapshot().mode === 'memory') {
      this.localAcknowledged = true
      this.derive()
      return Promise.resolve(true)
    }
    this.saving = true
    this.store.update((state) => { state.status = 'saving'; state.error = null })
    return this.scope.set(WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_VERSION).then(
      () => {
        this.saving = false
        this.derive()
        const { acknowledged } = this.store.getSnapshot()
        if (!acknowledged) {
          this.store.update((state) => {
            state.status = 'error'
            state.error = 'the acknowledgement did not persist'
          })
        }
        return acknowledged
      },
      (reason: Thrown) => {
        this.saving = false
        throw reason
      },
    )
  }

  /** Stop following the scope. */
  dispose(): void {
    this.following?.()
    this.following = undefined
  }

  private derive(): void {
    if (this.saving) return
    const scope = this.scope.getSnapshot()
    if (scope.mode === 'memory') {
      this.store.update((state) => {
        state.status = 'ready'
        state.acknowledged = this.localAcknowledged
        state.error = null
      })
      return
    }
    switch (scope.status) {
      case 'loading':
        this.store.update((state) => { state.status = 'loading'; state.error = null })
        return
      case 'unavailable':
        this.store.update((state) => {
          state.status = 'error'
          state.acknowledged = false
          state.error = 'welcome acknowledgement settings are unavailable'
        })
        return
      case 'ready': {
        const acknowledged = scope.value?.[WELCOME_NOTICE_ACK_FIELD] === WELCOME_NOTICE_VERSION
        this.store.update((state) => {
          state.status = 'ready'
          state.acknowledged = acknowledged
          state.error = null
        })
        return
      }
    }
  }
}
