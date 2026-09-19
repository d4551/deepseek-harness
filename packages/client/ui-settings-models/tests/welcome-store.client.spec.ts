import { describe, expect, it, vi } from 'vitest'
import type { JsonValue, SettingsNamespaceView } from '@deepseek-ai/dsh-api-remotes/client'
import {
  SettingsDescribeMirror, type SettingsRemote, type SettingsWireFace,
} from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-mirror.ts'
import { SettingsScopeController } from '@deepseek-ai/dsh-client-ui-settings/src/client/settings-scope.ts'
import { decodeWelcomeSection, WelcomeNoticeStore } from '../src/client/welcome-store.ts'
import {
  WELCOME_NOTICE_ACK_FIELD, WELCOME_NOTICE_SETTINGS_NAMESPACE, WELCOME_NOTICE_VERSION,
} from '../src/onboarding-copy.ts'

/** The settings namespace answers over the Remote carrier, which has no envelope. */
function ok<T>(value: T) {
  return { ok: true as const, value }
}

function unusedSettingsMethod(name: string): never {
  throw new Error(`${name} is unused in this spec`)
}

function welcomeWire(api: {
  describe?: SettingsRemote['describe']
  mutate?: SettingsRemote['mutate']
}): SettingsWireFace {
  return {
    settings: {
      describe: api.describe ?? (() => unusedSettingsMethod('describe')),
      update: () => unusedSettingsMethod('update'),
      replace: () => unusedSettingsMethod('replace'),
      mutate: api.mutate ?? (() => unusedSettingsMethod('mutate')),
    },
  }
}

function namespace(value: JsonValue = {}, revision = 0): SettingsNamespaceView {
  return {
    ns: WELCOME_NOTICE_SETTINGS_NAMESPACE,
    schema: {},
    value,
    applies: 'live',
    secrets: [],
    revision,
  }
}

function acknowledgedNamespace(version: string, revision = 1) {
  return namespace({ [WELCOME_NOTICE_ACK_FIELD]: version }, revision)
}

/** The welcome store over a real mirror-derived scope and a claimed wire. */
function buildWelcome(
  api: {
    describe?: ReturnType<typeof vi.fn<SettingsRemote['describe']>>
    mutate?: ReturnType<typeof vi.fn<SettingsRemote['mutate']>>
  },
  persistence: 'host' | 'memory' = 'host',
) {
  const wire = welcomeWire(api)
  const mirror = new SettingsDescribeMirror(wire, persistence)
  const scope = new SettingsScopeController(
    wire,
    { namespace: WELCOME_NOTICE_SETTINGS_NAMESPACE, decode: decodeWelcomeSection },
    mirror,
    persistence,
  )
  return { mirror, controller: new WelcomeNoticeStore(scope) }
}

describe('WelcomeNoticeStore', () => {
  it('acknowledges in memory while Host settings persistence is disabled', async () => {
    const describeCall = vi.fn<SettingsRemote['describe']>()
    const mutate = vi.fn<SettingsRemote['mutate']>()
    const { controller } = buildWelcome({ describe: describeCall, mutate }, 'memory')

    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: false, error: null })
    await expect(controller.acknowledge()).resolves.toBe(true)
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: true, error: null })
    await controller.load()
    expect(controller.store.getSnapshot()).toEqual({ status: 'ready', acknowledged: true, error: null })
    expect(describeCall).not.toHaveBeenCalled()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('acknowledges only the exact current copy version', async () => {
    for (const [version, acknowledged] of [
      [undefined, false],
      ['older-copy', false],
      [WELCOME_NOTICE_VERSION, true],
    ] as const) {
      const describeCall = vi.fn<SettingsRemote['describe']>(() => Promise.resolve(ok({
        writable: true,
        hasDocument: false,
        namespaces: [version === undefined ? namespace() : acknowledgedNamespace(version)],
      })))
      const { mirror, controller } = buildWelcome({ describe: describeCall })
      await mirror.load()
      await controller.load()
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged })
    }
  })

  it('persists the owner version through one revision-fenced mutation', async () => {
    const describeCall = vi.fn<SettingsRemote['describe']>(() => Promise.resolve(ok({
      writable: true, hasDocument: false, namespaces: [namespace({}, 3)],
    })))
    const mutate = vi.fn<SettingsRemote['mutate']>(() => Promise.resolve(ok(acknowledgedNamespace(WELCOME_NOTICE_VERSION, 4))))
    const { mirror, controller } = buildWelcome({ describe: describeCall, mutate })
    await mirror.load()
    await controller.load()
    await expect(controller.acknowledge()).resolves.toBe(true)
    expect(mutate).toHaveBeenCalledWith(
      WELCOME_NOTICE_SETTINGS_NAMESPACE,
      [{ op: 'set', path: [WELCOME_NOTICE_ACK_FIELD], value: WELCOME_NOTICE_VERSION }],
      3,
    )
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
    // The write answer folded into the mirror; no re-read followed.
    expect(describeCall).toHaveBeenCalledTimes(1)
  })

  it('keeps the notice pending while the settings read has not answered', async () => {
    const describeCall = vi.fn<SettingsRemote['describe']>(() => Promise.reject(new Error('offline')))
    const { mirror, controller } = buildWelcome({ describe: describeCall })
    await mirror.load()
    await controller.load()
    // No answer stands, so the step renders nothing and never acknowledges.
    expect(controller.store.getSnapshot()).toEqual({ status: 'loading', acknowledged: false, error: null })
  })

  it('reports a failed or refused persistence attempt after its recovery read', async () => {
    const describeCall = vi.fn<SettingsRemote['describe']>(() => Promise.resolve(ok({
      writable: true, hasDocument: false, namespaces: [namespace()],
    })))
    const mutate = vi.fn<SettingsRemote['mutate']>(() => Promise.reject(new Error('disk full')))
    const { mirror, controller } = buildWelcome({ describe: describeCall, mutate })
    await mirror.load()
    await controller.load()
    await expect(controller.acknowledge()).resolves.toBe(false)
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error',
      acknowledged: false,
      error: 'the acknowledgement did not persist',
    })
    // The failed latest write triggered one mirror recovery read.
    expect(describeCall).toHaveBeenCalledTimes(2)
  })

  it('reports a missing namespace as an error instead of a silent skip', async () => {
    const describeCall = vi.fn<SettingsRemote['describe']>(() => Promise.resolve(ok({
      writable: true, hasDocument: false, namespaces: [],
    })))
    const { mirror, controller } = buildWelcome({ describe: describeCall })
    await mirror.load()
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({
      status: 'error',
      error: 'welcome acknowledgement settings are unavailable',
    })
  })

  it('reads malformed durable values as unacknowledged', async () => {
    for (const value of [null, 42, { [WELCOME_NOTICE_ACK_FIELD]: 42 }]) {
      const describeCall = vi.fn<SettingsRemote['describe']>(() => Promise.resolve(ok({
        writable: true, hasDocument: false, namespaces: [namespace(value)],
      })))
      const { mirror, controller } = buildWelcome({ describe: describeCall })
      await mirror.load()
      await controller.load()
      expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: false })
    }
  })

  it('follows a later document change without an own read', async () => {
    const describeCall = vi.fn<SettingsRemote['describe']>()
      .mockResolvedValueOnce(ok({ writable: true, hasDocument: false, namespaces: [namespace()] }))
      .mockResolvedValueOnce(ok({
        writable: true, hasDocument: false,
        namespaces: [acknowledgedNamespace(WELCOME_NOTICE_VERSION)],
      }))
    const { mirror, controller } = buildWelcome({ describe: describeCall })
    await mirror.load()
    await controller.load()
    expect(controller.store.getSnapshot()).toMatchObject({ acknowledged: false })
    await mirror.load()
    expect(controller.store.getSnapshot()).toMatchObject({ status: 'ready', acknowledged: true })
  })
})
