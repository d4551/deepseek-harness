import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, expect, it } from 'vitest'

const directories: string[] = []
const execute = promisify(execFile)

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('denies host-based bare imports without the native resolver while retaining native URL imports', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-host-resolution-'))
  directories.push(root)
  const host = join(root, 'host')
  const installed = join(host, 'node_modules', 'host-only-plugin')
  mkdirSync(installed, { recursive: true })
  writeFileSync(join(installed, 'package.json'), JSON.stringify({ name: 'host-only-plugin', type: 'module', exports: './index.mjs' }))
  writeFileSync(join(installed, 'index.mjs'), 'export function apply(ctx) { ctx.provide("hostLoaded", true) }\n')
  const bareConfig = join(root, 'bare.json')
  writeFileSync(bareConfig, JSON.stringify([{ id: 'host', name: 'host-only-plugin' }]))
  const plugin = join(root, 'plugin.mjs')
  writeFileSync(plugin, 'export function apply(ctx, config) { ctx.provide(config.key, true) }\n')
  const urlConfig = join(root, 'urls.json')
  writeFileSync(urlConfig, JSON.stringify([
    { id: 'absolute', name: plugin, config: { key: 'absoluteLoaded' } },
    { id: 'url', name: pathToFileURL(plugin).href, config: { key: 'urlLoaded' } },
    { id: 'relative', name: './plugin.mjs', config: { key: 'relativeLoaded' } },
    { id: 'data', name: 'data:text/javascript,export function apply(ctx){ctx.provide("dataLoaded",true)}' },
    { id: 'group', name: 'cordis:group', config: [] },
  ]))
  const baseUrl = pathToFileURL(join(host, 'entry.mjs')).href
  const expected = `cannot resolve host plugin "host-only-plugin" from ${baseUrl}: native module loader is unavailable`
  const script = `
    import assert from 'node:assert/strict'
    import { boot } from ${JSON.stringify(new URL('../src/index.ts', import.meta.url).href)}
    const baseUrl = ${JSON.stringify(baseUrl)}
    let failedContext
    await assert.rejects(
      boot('host-resolution-test', ${JSON.stringify(bareConfig)}, undefined, ctx => { failedContext = ctx }, baseUrl),
      error => {
        assert.ok(error instanceof Error)
        let deepest = error
        while (deepest.cause instanceof Error) deepest = deepest.cause
        assert.equal(deepest.message, ${JSON.stringify(expected)})
        return true
      },
    )
    assert.ok(failedContext)
    assert.equal(failedContext.get('loader'), undefined)
    const ctx = await boot('host-resolution-test', ${JSON.stringify(urlConfig)}, undefined, undefined, baseUrl)
    try {
      assert.equal(ctx.loader.internal, undefined)
      for (const name of ['absoluteLoaded', 'urlLoaded', 'relativeLoaded', 'dataLoaded']) assert.equal(ctx.get(name), true)
      assert.ok(ctx.loader.resolve('include:group').fiber)
    } finally {
      await ctx.fiber.dispose()
    }
    console.log('native host resolution checked')
  `
  const result = await execute(process.execPath, [
    '--no-addons', '--import', import.meta.resolve('tsx'), '--input-type=module', '--eval', script,
  ])
  expect(result.stderr).toBe('')
  expect(result.stdout).toBe('native host resolution checked\n')
})
