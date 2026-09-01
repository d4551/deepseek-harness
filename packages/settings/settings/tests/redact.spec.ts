import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { redactSecrets, settingsNamespace } from '../src/index.ts'
import { MemorySettings } from './memory.ts'

const Profile = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref'),
  baseURL: z.string(),
})

const Adapter: z<object> = z.object({
  apiKey: z.string().role('secret'),
  providers: z.dict(Profile),
  fallbacks: z.array(Profile),
  nested: z.object({
    token: z.string().role('secret'),
  }),
})

describe('redactSecrets', () => {
  it('strips secrets from object, dict, and array containers and records each position', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      apiKey: 'top-secret',
      providers: {
        openai: { apiKey: 'sk-live', apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ apiKey: 'fb', baseURL: 'https://y' }],
      nested: {},
    })
    expect(value).toEqual({
      providers: {
        openai: { apiKeyEnv: 'OPENAI_API_KEY', baseURL: 'https://x' },
        anthropic: { apiKeyEnv: 'ANTHROPIC_API_KEY' },
      },
      fallbacks: [{ baseURL: 'https://y' }],
      nested: {},
    })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: true },
      { path: ['providers', 'openai', 'apiKey'], set: true },
      { path: ['providers', 'anthropic', 'apiKey'], set: false },
      { path: ['fallbacks', '0', 'apiKey'], set: true },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('enumerates unset object-property slots without inventing containers', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, undefined)
    expect(value).toBeUndefined()
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('never mutates the input and preserves keys outside the schema', () => {
    const input = Object.freeze({
      apiKey: 'frozen',
      extra: Object.freeze({ keep: true }),
    })
    const { value } = redactSecrets(Adapter as z<never>, input)
    expect(input.apiKey).toBe('frozen')
    expect(value).toEqual({ extra: { keep: true }, nested: undefined } as never)
    expect((value as { extra: unknown }).extra).toEqual({ keep: true })
  })

  it('passes malformed container values through untouched', () => {
    const { value, secrets } = redactSecrets(Adapter as z<never>, {
      providers: 'not-a-dict',
      fallbacks: 'not-an-array',
    })
    expect(value).toEqual({ providers: 'not-a-dict', fallbacks: 'not-an-array' })
    expect(secrets).toEqual([
      { path: ['apiKey'], set: false },
      { path: ['nested', 'token'], set: false },
    ])
  })

  it('treats a secret-role container as one opaque secret leaf', () => {
    const Weird = z.object({ blob: z.object({ inner: z.string() }).role('secret') })
    const { value, secrets } = redactSecrets(Weird as z<never>, { blob: { inner: 'x' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['blob'], set: true }])
  })

  it('drops a dict entry whose entire value is the secret', () => {
    const Tokens = z.object({ tokens: z.dict(z.string().role('secret')) })
    const { value, secrets } = redactSecrets(Tokens as z<never>, { tokens: { a: 'x', b: 'y' } })
    expect(value).toEqual({ tokens: {} })
    expect(secrets).toEqual([
      { path: ['tokens', 'a'], set: true },
      { path: ['tokens', 'b'], set: true },
    ])
  })

  it('tolerates structural nodes missing their relation maps', () => {
    expect(redactSecrets({ type: 'dict' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'object' } as never, { k: 'v' })).toEqual({ value: { k: 'v' }, secrets: [] })
    expect(redactSecrets({ type: 'array' } as never, ['v'])).toEqual({ value: ['v'], secrets: [] })
  })
})

describe('redactSecrets over composite node kinds', () => {
  it('strips a tuple member by position and leaves later members to their own schema', () => {
    const Pair = z.object({ pair: z.tuple([z.string(), z.string().role('secret')]) })
    const { value, secrets } = redactSecrets(Pair as z<never>, { pair: ['keep', 'sk-live', 'extra'] })
    expect(value).toEqual({ pair: ['keep', undefined, 'extra'] })
    expect(secrets).toEqual([{ path: ['pair', '1'], set: true }])
  })

  it('passes a non-array tuple value through untouched', () => {
    const Pair = z.object({ pair: z.tuple([z.string().role('secret')]) })
    const { value, secrets } = redactSecrets(Pair as z<never>, { pair: 'not-a-tuple' })
    expect(value).toEqual({ pair: 'not-a-tuple' })
    expect(secrets).toEqual([])
  })

  it('strips a secret declared in a union member', () => {
    const Either = z.object({ field: z.union([z.string().role('secret'), z.const(null)]) })
    const { value, secrets } = redactSecrets(Either as z<never>, { field: 'sk-live' })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['field'], set: true }])
  })

  it('carries a value through a union whose members declare no secret', () => {
    const Either = z.object({ field: z.union([z.string(), z.number()]) })
    const { value, secrets } = redactSecrets(Either as z<never>, { field: 'plain' })
    expect(value).toEqual({ field: 'plain' })
    expect(secrets).toEqual([])
  })

  it('returns the value for a union node carrying no member list', () => {
    expect(redactSecrets({ type: 'union' } as never, 'v')).toEqual({ value: 'v', secrets: [] })
  })

  it('strips a secret contributed by one intersect member and keeps the others', () => {
    const Both = z.intersect([
      z.object({ keep: z.string() }),
      z.object({ token: z.string().role('secret') }),
    ])
    const { value, secrets } = redactSecrets(Both as z<never>, { keep: 'k', token: 'sk-live' })
    expect(value).toEqual({ keep: 'k' })
    expect(secrets).toEqual([{ path: ['token'], set: true }])
  })

  it('removes a transform subtree that declares a secret beneath it', () => {
    const Wrapped = z.object({
      creds: z.transform(z.object({ token: z.string().role('secret') }), entry => entry),
    })
    const { value, secrets } = redactSecrets(Wrapped as z<never>, { creds: { token: 'sk-live' } })
    expect(value).toEqual({})
    expect(secrets).toEqual([{ path: ['creds'], set: true }])
  })

  it('passes a transform declaring no secret through untouched', () => {
    const Wrapped = z.object({ when: z.transform(z.string(), entry => entry) })
    const { value, secrets } = redactSecrets(Wrapped as z<never>, { when: '2026-01-01' })
    expect(value).toEqual({ when: '2026-01-01' })
    expect(secrets).toEqual([])
  })

  it('terminates on a self-referential node that declares no secret', () => {
    const node: Record<string, unknown> = { type: 'recursive' }
    node.inner = node
    expect(redactSecrets(node as never, 'v')).toEqual({ value: 'v', secrets: [] })
  })

  it('returns the value for a tuple node carrying no member list', () => {
    expect(redactSecrets({ type: 'tuple' } as never, ['v'])).toEqual({ value: ['v'], secrets: [] })
  })

  it('scans past a secret-free member to find a secret in an unmodelled node list', () => {
    const node = {
      type: 'extension',
      list: [{ type: 'string' }, { type: 'string', meta: { role: 'secret' } }],
    }
    expect(redactSecrets(node as never, 'v')).toEqual({ value: undefined, secrets: [{ path: [], set: true }] })
  })

  it('scans past a secret-free property to find a secret in an unmodelled node property map', () => {
    const node = {
      type: 'extension',
      dict: { plain: { type: 'string' }, token: { type: 'string', meta: { role: 'secret' } } },
    }
    expect(redactSecrets(node as never, undefined)).toEqual({ value: undefined, secrets: [{ path: [], set: false }] })
  })

  it('keeps a value whose unmodelled node declares no secret in any relation', () => {
    const node = {
      type: 'extension',
      dict: { plain: { type: 'string' } },
      list: [{ type: 'number' }],
    }
    expect(redactSecrets(node as never, 'v')).toEqual({ value: 'v', secrets: [] })
  })
})

describe('describe() layers and redaction', () => {
  const NS = settingsNamespace('adapter')

  async function boot(doc?: Record<string, unknown>) {
    const ctx = new Context()
    await ctx.plugin(MemorySettings, doc === undefined ? undefined : { doc })
    return ctx
  }

  it('exposes detached base and user layers beside the resolved value', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const base = { apiKey: 'entry-key', baseURL: 'https://base' }
    ctx.settings.register(NS, Profile, { base })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor?.base).toEqual(base)
    expect(descriptor?.base).not.toBe(base)
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.value).toEqual({ apiKey: 'entry-key', baseURL: 'https://user' })
    ;(descriptor?.user as Record<string, unknown>).baseURL = 'mutated'
    expect(ctx.settings.describe()[0]?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toBeUndefined()
  })

  it('omits the layers when neither a base nor a user section exists', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
  })

  it('describes a section that became malformed after registration as having no user layer', async () => {
    const ctx = await boot({ adapter: { baseURL: 'https://user' } })
    const provider = ctx.get('settings') as MemorySettings
    ctx.settings.register(NS, Profile, { base: { baseURL: 'https://base' } })
    provider.pushExternal({ adapter: 5 })
    const [descriptor] = ctx.settings.describe()
    expect(descriptor).not.toHaveProperty('user')
    // The malformed publish kept the last good resolved value.
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
  })

  it('redacts a descriptor that has neither base nor user layer', async () => {
    const ctx = await boot()
    ctx.settings.register(NS, Profile)
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor).not.toHaveProperty('base')
    expect(descriptor).not.toHaveProperty('user')
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: false }])
  })

  it('redacts every layer and enumerates secret slots under redactSecrets', async () => {
    const ctx = await boot({ adapter: { apiKey: 'user-key', baseURL: 'https://user' } })
    ctx.settings.register(NS, Profile, { base: { apiKey: 'entry-key' } })
    const [descriptor] = ctx.settings.describe({ redactSecrets: true })
    expect(descriptor?.value).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.base).toEqual({})
    expect(descriptor?.user).toEqual({ baseURL: 'https://user' })
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    const [verbatim] = ctx.settings.describe()
    expect(verbatim?.value).toEqual({ apiKey: 'user-key', baseURL: 'https://user' })
  })
})
