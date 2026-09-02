/**
 * Shared Host stand-ins for the controller specs: a settings scope that
 * behaves like a Host which accepts writes, a credentials face stub, and a
 * deferred for tests that settle a wire call by hand.
 */

import { vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { StubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import type { SettingsScopeSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'

/** The JSON value a `set` op carries, straight off the wire type. */
type SetValue = Extract<SettingsPathOpView, { op: 'set' }>['value']
/** A section object as the accepting-Host stand-in stores it. */
export type Section = Record<string, SetValue>

/**
 * Make the stub behave like a Host that accepts every write.
 *
 * Generic over the caller's settings type: the accepted section grows from
 * the snapshot's own value, while the raw user/base layers are read back as
 * the JSON records the stand-in stores.
 * @param host - the stub whose write spies should commit and publish.
 */
export function acceptWrites<T extends object>(host: StubSettingsScope<T>): void {
  /** One snapshot layer as the raw JSON record it stores; an absent layer is empty. */
  const layer = (raw: SettingsScopeSnapshot<T>['user']): Section =>
    // The user layer is a JSON record of the section's own values; narrowing
    // cannot carry that through the generic snapshot type, so assert it here.
    typeof raw === 'object' && raw !== null
      ? Object.fromEntries(Object.entries(raw) as [string, SetValue][])
      : {}
  host.set.mockImplementation((field: string, value: SetValue) => {
    const snap = host.scope.getSnapshot()
    const section = snap.value
    host.publish({
      ...(section !== undefined && { value: { ...section, [field]: value } }),
      user: { ...layer(snap.user), [field]: value },
    })
  })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const snap = host.scope.getSnapshot()
    let section = snap.value
    const user = { ...layer(snap.user) }
    for (const op of ops) {
      const field = op.path[0]!
      if (op.op === 'set') {
        if (section !== undefined) section = { ...section, [field]: op.value }
        user[field] = op.value
      }
    }
    host.publish({ ...(section !== undefined && { value: section }), user })
  })
  host.unset.mockImplementation((field: string) => {
    const snap = host.scope.getSnapshot()
    const section = snap.value
    host.publish({
      ...(section !== undefined && { value: { ...section, [field]: layer(snap.base)[field] } }),
      user: Object.fromEntries(Object.entries(layer(snap.user)).filter(([key]) => key !== field)),
    })
  })
}

/** A credentials domain face that reports one reference as configured or not. */
export function credentialsApi(configured: boolean) {
  const describe = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { DEEPSEEK_API_KEY: { configured, writable: true } },
  }))
  const set = vi.fn(() => Promise.resolve({ ok: true as const, value: undefined }))
  return { api: { describe, set } as never, describe, set }
}

/** A promise whose settlement a test controls from the outside. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept
    reject = fail
  })
  return { promise, resolve, reject }
}
