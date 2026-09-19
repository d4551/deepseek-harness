import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  credentialKey, credentialKeyId, credentialKeyScope, credentialRef, isCredentialKeySegment,
  parseCredentialKey,
} from '../src/index.ts'
import type { CredentialKey, CredentialRef } from '../src/index.ts'
import { MemoryCredentials } from './memory.ts'

/** Test provider that publishes through the seam's contained fan-out. */
class AnnouncingCredentials extends MemoryCredentials {
  announceRef(ref: CredentialRef): void {
    this.notifyUpdated(ref)
  }

  announceRecord(key: CredentialKey): void {
    this.notifyRecordUpdated(key)
  }
}

const REF = credentialRef('DEEPSEEK_API_KEY')

async function boot(seed: Record<string, string> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryCredentials, seed)
  return ctx
}

describe('credentialRef', () => {
  it('brands POSIX shell identifiers', () => {
    expect(credentialRef('DEEPSEEK_API_KEY')).toBe('DEEPSEEK_API_KEY')
    expect(credentialRef('_private')).toBe('_private')
    expect(credentialRef('lower_case9')).toBe('lower_case9')
  })

  it('rejects every other shape', () => {
    for (const invalid of ['', '9LEADING', 'WITH-DASH', 'WITH SPACE', 'ns:key']) {
      expect(() => credentialRef(invalid)).toThrow(TypeError)
    }
  })
})

describe('isCredentialKeySegment', () => {
  it('answers whether credentialKey would accept the segment', () => {
    for (const valid of ['llm-pi-ai', 'openai-codex', 'a', 'z9']) {
      expect(isCredentialKeySegment(valid)).toBe(true)
    }
    // The shapes an arbitrary settings dict key can take that a record id
    // cannot: a consumer asks here instead of learning it from a throw.
    for (const invalid of ['', 'My_Proxy', 'z.ai', 'UPPER', '9leading', 'a/b']) {
      expect(isCredentialKeySegment(invalid)).toBe(false)
    }
  })
})

describe('credentialKey', () => {
  it('brands two lowercase hyphenated segments and refuses any other shape', () => {
    const key = credentialKey('llm-pi-ai', 'openai-codex')
    expect(key).toBe('llm-pi-ai/openai-codex')
    expect(credentialKeyScope(key)).toBe('llm-pi-ai')
    expect(credentialKeyId(key)).toBe('openai-codex')
    expect(parseCredentialKey('llm-pi-ai/openai-codex')).toBe(key)
    expect(() => credentialKey('llm-pi-ai', 'OpenAI')).toThrow(TypeError)
    expect(() => parseCredentialKey('openai-codex')).toThrow(/must be "<scope>\/<id>"/)
    expect(() => parseCredentialKey('a/b/c')).toThrow(/must be "<scope>\/<id>"/)
  })
})

describe('the contained update fan-out', () => {
  it('keeps a throwing listener from changing a commit, and later listeners still run', () => {
    const ctx = new Context()
    const credentials = new AnnouncingCredentials(ctx)
    ctx.on('credentials/reference-updated', () => {
      throw new Error('observer boom')
    })
    const second = vi.fn<(ref: CredentialRef) => void>()
    ctx.on('credentials/reference-updated', second)

    expect(() => { credentials.announceRef(REF) }).not.toThrow()
    expect(second).toHaveBeenCalledWith(REF)
  })

  it('contains an async listener rejection', async () => {
    const ctx = new Context()
    const credentials = new AnnouncingCredentials(ctx)
    const boom = (): Promise<never> => Promise.reject(new Error('async observer boom'))
    ctx.on('credentials/reference-updated', boom)

    expect(() => { credentials.announceRef(REF) }).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 10))
  })

  it('rethrows an invariant-coded listener failure after the remaining listeners', () => {
    const ctx = new Context()
    const credentials = new AnnouncingCredentials(ctx)
    ctx.on('credentials/record-updated', () => {
      throw Object.assign(new Error('forged relation'), { code: 'INVARIANT' })
    })
    const second = vi.fn<(key: CredentialKey) => void>()
    ctx.on('credentials/record-updated', second)
    const key = credentialKey('llm-pi-ai', 'openai-codex')

    expect(() => { credentials.announceRecord(key) }).toThrow(/forged relation/)
    expect(second).toHaveBeenCalledWith(key)
  })
})

describe('the credentials seam through the memory provider', () => {
  it('mounts as ctx.credentials and resolves a seeded reference with its source', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: 'sk-seeded' })
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-seeded', source: 'memory' })
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: true, source: 'memory', writable: true })
  })

  it('treats an empty stored value as absent everywhere', async () => {
    const ctx = await boot({ DEEPSEEK_API_KEY: '' })
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(await ctx.credentials.describe(REF)).toEqual({ configured: false, writable: true })
  })

  it('stores through set, removes through unset, and emits the committed change', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/reference-updated', (ref) => { events.push(ref) })

    await ctx.credentials.set(REF, 'sk-live')
    expect(await ctx.credentials.resolve(REF)).toEqual({ value: 'sk-live', source: 'memory' })
    await ctx.credentials.unset(REF)
    expect(await ctx.credentials.resolve(REF)).toBeUndefined()
    expect(events).toEqual([REF, REF])
  })

  it('rejects an empty set and keeps an absent unset silent', async () => {
    const ctx = await boot()
    const events: CredentialRef[] = []
    ctx.on('credentials/reference-updated', (ref) => { events.push(ref) })

    await expect(ctx.credentials.set(REF, '')).rejects.toThrow(/empty value/)
    await ctx.credentials.unset(REF)
    expect(events).toEqual([])
  })

  it('removes the service with its fiber', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(MemoryCredentials)
    expect(ctx.get('credentials')).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('credentials')).toBeUndefined()
  })
})
