import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { describe, expect, it } from 'vitest'
import { settingsNamespace } from '../src/index.ts'
import type { SettingsScope } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

describe('settings capability readiness', () => {
  it('publishes runtime readiness separately from configuration and rejects stale owners', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    const namespace = settingsNamespace('browser-availability')
    const events: boolean[] = []
    ctx.on('settings/availability-updated', (_ns, available) => { events.push(available) })
    let scope: SettingsScope<{ path: string }> | undefined
    const registration = await ctx.plugin({
      name: 'availability-owner',
      inject: ['settings'],
      apply: (owner: Context) => {
        scope = owner.settings.register(namespace, z.object({ path: z.string().default('/configured') }), {
          available: false,
          applies: 'restart',
        })
      },
    })
    if (scope === undefined) throw new Error('Settings owner did not register')
    expect(ctx.settings.describe()[0]?.available).toBe(false)
    scope.setAvailable(true)
    expect(ctx.settings.describe({ redactSecrets: true })[0]).toMatchObject({
      available: true, revision: 0, value: { path: '/configured' },
    })
    scope.setAvailable(true)
    expect(events).toEqual([true])
    await registration.dispose()
    scope.setAvailable(false)
    expect(events).toEqual([true])
    expect(ctx.settings.describe()).toEqual([])
    await ctx.fiber.dispose()
  })
})
