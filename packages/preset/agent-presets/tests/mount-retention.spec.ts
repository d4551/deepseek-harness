import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('releases disposed preset records without another registry read or mount', async () => {
  const script = `
    import assert from 'node:assert/strict'
    import { mkdtemp, rm, writeFile, stat } from 'node:fs/promises'
    import { tmpdir } from 'node:os'
    import { join } from 'node:path'
    import { pathToFileURL } from 'node:url'
    import { setImmediate } from 'node:timers/promises'
    import { Context } from '@deepseek-ai/cordis'
    import Loader from '@deepseek-ai/cordis-plugin-loader'
    import { createScope } from '@deepseek-ai/dsh-scope'
    import { mountPreset, livePresetMounts } from ${JSON.stringify(new URL('../src/mount.ts', import.meta.url).href)}

    async function mountAndDispose() {
      const root = await mkdtemp(join(tmpdir(), 'dsh-preset-retention-'))
      const resource = join(root, 'owned.txt')
      const path = join(root, 'agent.cordis.json')
      await writeFile(path, JSON.stringify([{ id: 'resource', name: 'cordis:resource' }]))
      const ctx = new Context()
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.resource = async function resourceOwner(pluginCtx) {
        await writeFile(resource, 'owned')
        pluginCtx.effect(() => () => rm(resource))
      }
      const key = {}
      const scoped = createScope(ctx, key)
      await mountPreset(scoped.ctx, { id: 'retained', trust: 'user', path })
      assert.equal((await stat(resource)).isFile(), true)
      const record = livePresetMounts().find(mount => mount.key === key)
      assert.ok(record)
      const reference = new WeakRef(record)
      await ctx.fiber.dispose()
      await assert.rejects(stat(resource), { code: 'ENOENT' })
      await rm(root, { recursive: true, force: true })
      return reference
    }

    const reference = await mountAndDispose()
    for (let checkpoint = 0; checkpoint < 5; checkpoint += 1) {
      await setImmediate()
      globalThis.gc()
    }
    // Inspecting a retained Cordis object invokes service getters and hides this assertion.
    assert.equal(reference.deref() === undefined, true, 'disposed preset remains retained by the mount registry')
    console.log('disposed preset released')
  `
  const result = await promisify(execFile)(process.execPath, [
    '--expose-gc', '--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script,
  ])
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('disposed preset released\n')
})
