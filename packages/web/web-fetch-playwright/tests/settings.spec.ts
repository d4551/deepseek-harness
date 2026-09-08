/**
 * The `web-fetch-playwright` settings section: the render limits it publishes,
 * and the browser its composition layer names — or does not, when the mount
 * probe found no installation.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { MemorySettings } from './settings-provider.ts'
import WebRuntime from '@deepseek-ai/dsh-web'
import type { BrowserAccess } from '../src/provider.ts'
import { fakeBrowser, fakeExecutable } from './fakes.ts'
import * as playwrightPlugin from '../src/index.ts'
import { WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE } from '../src/index.ts'

/** Mount the seam, a writable document, and the plugin over one browser access. */
async function boot(access: BrowserAccess, config: playwrightPlugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  const settings = ctx.plugin(MemorySettings)
  await settings.await()
  await ctx.plugin(WebRuntime, {})
  await ctx.plugin({
    name: 'web-fetch-playwright-settings-test',
    inject: ['web'],
    apply: async (pluginCtx: Context) => {
      await playwrightPlugin.apply(pluginCtx, playwrightPlugin.Config(config), access)
    },
  })
  return ctx
}

/** The descriptor this plugin publishes for its own namespace. */
function section(ctx: Context) {
  return ctx.settings.describe().find(entry => entry.ns === WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE)
}

describe('web-fetch-playwright settings', () => {
  it('applies stored limits and browser selection on remount while preserving restart timing', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings)
    await ctx.plugin(WebRuntime, { fetchProvider: 'playwright' })
    const { access, browser } = fakeBrowser()
    const probes: (string | undefined)[] = []
    const mount = () => ctx.plugin({
      name: 'browser-settings-remount',
      inject: ['web', 'settings'],
      apply: (pluginCtx: Context) => playwrightPlugin.apply(pluginCtx, playwrightPlugin.Config({}), {
        launch: access.launch,
        probe: (selection) => {
          probes.push(selection.executablePath)
          return access.probe(selection)
        },
      }),
    })
    const first = await mount()
    await ctx.settings.update(WEB_FETCH_PLAYWRIGHT_SETTINGS_NAMESPACE, {
      maxBodyChars: 8, executablePath: '/stored/browser',
    })
    const before = await ctx.web.fetch({ url: 'https://example.com/' })
    expect(before.body.content.length).toBeGreaterThan(8)
    await first.dispose()
    const second = await mount()
    const after = await ctx.web.fetch({ url: 'https://example.com/' })
    expect(after.body.content).toHaveLength(8)
    expect(after.truncated).toBe(true)
    expect(probes).toEqual([undefined, '/stored/browser'])
    expect(browser.newContextCount).toBe(2)
    expect(section(ctx)?.available).toBe(true)
    await second.dispose()
    expect(section(ctx)).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('publishes the render limits and declares that a change waits for the next boot', async () => {
    const { access } = fakeBrowser()

    const ctx = await boot(access, { maxBodyChars: 100, timeoutMs: 5_000, maxConcurrentRenders: 3 })

    expect(section(ctx)?.base).toMatchObject({ maxBodyChars: 100, timeoutMs: 5_000, maxConcurrentRenders: 3 })
    expect(section(ctx)?.applies).toBe('restart')
  })

  it('reports browser readiness independently of the configured path', async () => {
    const { access } = fakeBrowser()

    const ctx = await boot(access)

    expect(section(ctx)?.available).toBe(true)
    expect(section(ctx)?.base).not.toHaveProperty('executablePath')
  })

  it('names no browser when the probe found none, even with one configured', async () => {
    const { access } = fakeBrowser()
    const missing: BrowserAccess = {
      launch: access.launch,
      probe: () => Promise.reject(new Error('no chromium binary')),
    }

    const ctx = await boot(missing, { executablePath: '/configured/but/absent' })

    expect(section(ctx)?.available).toBe(false)
    expect(section(ctx)?.base).toMatchObject({ executablePath: '/configured/but/absent' })
  })

  it('probes and launches the configured executable rather than Playwright’s own', async () => {
    const probed: string[] = []
    const launched: string[] = []
    const { access, browser } = fakeBrowser()
    const named: BrowserAccess = {
      launch: async (selection) => {
        launched.push(selection.executablePath ?? '')
        return await access.launch(selection)
      },
      probe: (selection) => {
        probed.push(selection.executablePath ?? '')
        return Promise.resolve(selection.executablePath ?? fakeExecutable)
      },
    }

    const ctx = await boot(named, { executablePath: '/opt/chrome' })
    await ctx.web.fetch({ url: 'https://example.com/rendered' })

    expect(probed).toEqual(['/opt/chrome'])
    expect(launched).toEqual(['/opt/chrome'])
    expect(browser.newContextCount).toBe(1)
  })
})
