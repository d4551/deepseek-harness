import { deepStrictEqual } from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import z from '@deepseek-ai/schemastery'
import FileSettingsProvider from '../../settings-file/src/index.ts'
import { settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const namespace = settingsNamespace('json-properties')
const profile = z.object({ label: z.string(), token: z.string().role('secret') })
const dictionary = z.object({ entries: z.dict(profile).default({}) })

function expectOwnData(value: unknown, key: string, expected: unknown): void {
  if (typeof value !== 'object' || value === null) throw new Error('expected an object of settings properties')
  expect(Object.getPrototypeOf(value)).toBe(Object.prototype)
  expect(Object.getOwnPropertyDescriptor(value, key)).toEqual({
    value: expected, enumerable: true, configurable: true, writable: true,
  })
}

async function memoryContext(): Promise<Context> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(MemorySettings)
  return ctx
}

describe('settings property names', () => {
  it('preserves undeclared own data while removing declared secrets', async () => {
    const ctx = await memoryContext()
    const scope = ctx.settings.register(namespace, z.object({ token: z.string().role('secret') }))
    const ownProperties = Object.fromEntries<unknown>([
      ['__proto__', { label: 'prototype data' }],
      ['constructor', 'constructor data'],
      ['toString', 'method data'],
    ])
    await scope.update({ ...ownProperties, token: 'private-token' })
    const descriptor = ctx.settings.describe({ redactSecrets: true })[0]
    expect(descriptor?.user).toStrictEqual(ownProperties)
    for (const [key, value] of Object.entries(ownProperties)) expectOwnData(descriptor?.user, key, value)
    expect(descriptor?.secrets).toEqual([{ path: ['token'], set: true }])
    expect(JSON.stringify(descriptor?.user)).not.toContain('private-token')
    expect(Object.hasOwn(Object.prototype, 'label')).toBe(false)
  })

  it('keeps dictionary keys in every redacted layer without retaining their secrets', async () => {
    const ctx = await memoryContext()
    const entries = Object.fromEntries(['__proto__', 'constructor', 'toString'].map(key => [key, { label: key, token: `${key}-secret` }]))
    const scope = ctx.settings.register(namespace, dictionary, { base: { entries } })
    await scope.replace({ entries })
    const descriptor = ctx.settings.describe({ redactSecrets: true })[0]
    const publicEntries = Object.fromEntries(Object.keys(entries).map(key => [key, { label: key }]))
    for (const layer of [descriptor?.base, descriptor?.user, descriptor?.value]) {
      deepStrictEqual(layer, { entries: publicEntries })
      const layerEntries: unknown = Object.getOwnPropertyDescriptor(layer ?? {}, 'entries')?.value
      for (const key of Object.keys(entries)) expectOwnData(layerEntries, key, { label: key })
    }
    expect(descriptor?.secrets).toEqual(Object.keys(entries).map(key => ({ path: ['entries', key, 'token'], set: true })))
    deepStrictEqual(scope.get().entries, entries)
  })

  it('preserves explicitly declared collision keys and treats absent secret keys as unset', async () => {
    const ctx = await memoryContext()
    const schema = z.object({ ['__proto__']: z.string(), constructor: z.string(), toString: z.string().role('secret') })
    const scope = ctx.settings.register(namespace, schema)
    await scope.update({ ['__proto__']: 'data', constructor: 'entry' })
    const descriptor = ctx.settings.describe({ redactSecrets: true })[0]
    expectOwnData(descriptor?.user, '__proto__', 'data')
    expectOwnData(descriptor?.user, 'constructor', 'entry')
    expect(descriptor?.secrets).toEqual([{ path: ['toString'], set: false }])
  })

  it('applies schema defaults and required checks to absent own properties', () => {
    const defaults = z.object({
      ['__proto__']: z.string().default('prototype default'),
      constructor: z.string().default('constructor default'),
      toString: z.string().default('method default'),
    })
    deepStrictEqual(defaults(), {
      ['__proto__']: 'prototype default', constructor: 'constructor default', toString: 'method default',
    })
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(() => z.object({ [key]: z.string().required() })({})).toThrow('missing required value')
    }
  })

  it('round-trips collision keys through the file provider and a fresh Loader composition', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-settings-properties-'))
    const contexts: Context[] = []
    onTestFinished(async () => {
      for (const ctx of contexts) await ctx.fiber.dispose()
      await rm(root, { recursive: true, force: true })
    })
    const documentPath = join(root, 'settings.json')
    const compositionPath = join(root, 'cordis.yml')
    await writeFile(compositionPath, [
      '- name: cordis:settings-file',
      '  config:',
      `    path: ${JSON.stringify(documentPath)}`,
      '    watch: false', '',
    ].join('\n'))
    const load = async (): Promise<Context> => {
      const ctx = new Context()
      contexts.push(ctx)
      ctx.baseUrl = pathToFileURL(root).href + '/'
      await ctx.plugin(Loader)
      ctx.loader.builtins.include = Include
      ctx.loader.builtins['settings-file'] = FileSettingsProvider
      await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(compositionPath).href } })
      await ctx.loader.await()
      return ctx
    }
    const first = await load()
    const original = first.settings.register(namespace, dictionary)
    const entries = Object.fromEntries(['__proto__', 'constructor', 'toString'].map(key => [key, { label: key, token: `${key}-secret` }]))
    await original.update({ entries })
    const persisted: unknown = JSON.parse(await readFile(documentPath, 'utf8'))
    deepStrictEqual(persisted, { [namespace]: { entries } })
    await first.fiber.dispose()
    const reopened = await load()
    const restored = reopened.settings.register(namespace, dictionary)
    deepStrictEqual(restored.get().entries, entries)
    const descriptor = reopened.settings.describe({ redactSecrets: true })[0]
    deepStrictEqual(descriptor?.user, { entries: Object.fromEntries(Object.keys(entries).map(key => [key, { label: key }])) })
    expect(JSON.stringify(descriptor)).not.toContain('-secret')
  })
})
