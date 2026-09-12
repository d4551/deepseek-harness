/**
 * The wire-values module is what both halves of a dynamic package compute
 * identically: the guard's verb forwarder, the realm-crossing error record,
 * and the inspect-provider manifests. These are the paths the runner suites
 * reach only indirectly — the timer refusal, a throw whose fields are not
 * strings, a model input that is not an object — pinned here directly.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import {
  ANY_OUTPUT,
  CTX_VERBS,
  EMPTY_INPUT,
  ctxVerbForwarder,
  errorDetails,
  inspectProvider,
  readExact,
} from '../src/wire-values.ts'

describe('ctxVerbForwarder', () => {
  it('answers nothing for a name outside the verb whitelist', () => {
    expect(ctxVerbForwarder(new Context(), 'registry', new Set(), () => { throw new Error('unreached') })).toBeUndefined()
    expect(CTX_VERBS.has('registry')).toBe(false)
  })

  it('refuses a timer verb until the plugin declares the timer service, without touching the ctx', () => {
    const denied: string[] = []
    const forward = ctxVerbForwarder(new Context(), 'setTimeout', new Set(['slots']), (name) => {
      denied.push(name)
      throw new Error(`denied ${name}`)
    })
    expect(() => forward?.(() => undefined, 10)).toThrow('denied timer')
    expect(denied).toEqual(['timer'])
  })

  it('forwards a lifecycle verb to the real ctx with the ctx as receiver', () => {
    const ctx = new Context()
    const forward = ctxVerbForwarder(ctx, 'effect', new Set(), () => { throw new Error('unreached') })
    let ran = 0
    const dispose = forward?.(() => {
      ran += 1
      return () => { ran += 10 }
    })
    expect(ran).toBe(1)
    expect(typeof dispose).toBe('function')
  })
})

describe('errorDetails', () => {
  it('reads message and stack by name, so a throw from another realm keeps both', () => {
    const error = new Error('boom')
    expect(errorDetails(error)).toEqual({ message: 'boom', stack: error.stack })
    expect(errorDetails({ message: 'cross-realm', stack: 'at somewhere' })).toEqual({ message: 'cross-realm', stack: 'at somewhere' })
  })

  it('describes a throw whose message is not a string by its object tag, and drops a non-string stack', () => {
    expect(errorDetails({ message: 42, stack: 7 })).toEqual({ message: '[object Object]' })
    expect(errorDetails({ message: 'kept', stack: ['not', 'a', 'stack'] })).toEqual({ message: 'kept' })
  })

  it('stringifies a primitive throw', () => {
    expect(errorDetails('plain')).toEqual({ message: 'plain' })
    expect(errorDetails(null)).toEqual({ message: 'null' })
  })
})

describe('readExact', () => {
  it('reads the named string out of an object input and nothing else', () => {
    expect(readExact({ service: 'timer' }, 'service')).toBe('timer')
    expect(readExact({ service: 3 }, 'service')).toBeUndefined()
    expect(readExact({ other: 'x' }, 'service')).toBeUndefined()
  })

  it('answers undefined for inputs that are not objects', () => {
    expect(readExact(undefined, 'service')).toBeUndefined()
    expect(readExact(null, 'service')).toBeUndefined()
    expect(readExact(['service'], 'service')).toBeUndefined()
    expect(readExact('service', 'service')).toBeUndefined()
    expect(readExact(4, 'service')).toBeUndefined()
  })
})

describe('inspectProvider', () => {
  it('declares one method that carries the provider description and the default schemas', () => {
    const provider = inspectProvider('clock', 'Reads the clock.', 'now', () => 42)
    expect(provider.manifest).toEqual({
      id: 'clock',
      description: 'Reads the clock.',
      methods: [{ name: 'now', description: 'Reads the clock.', inputSchema: EMPTY_INPUT, outputSchema: ANY_OUTPUT }],
    })
  })

  it('answers its declared method, synchronously or not, with the input it was sent', async () => {
    const seen: (string | undefined)[] = []
    const provider = inspectProvider('names', 'Reads names.', 'read', (input) => {
      seen.push(readExact(input, 'name'))
      return Promise.resolve({ found: seen.length })
    }, { type: 'object' }, { type: 'object' })
    await expect(provider.query('read', { name: 'a' }, null)).resolves.toEqual({ found: 1 })
    await expect(provider.query('read', undefined, null)).resolves.toEqual({ found: 2 })
    expect(seen).toEqual(['a', undefined])
    expect(provider.manifest.methods[0]?.inputSchema).toEqual({ type: 'object' })
  })

  it('refuses a method it never declared', async () => {
    const provider = inspectProvider('clock', 'Reads the clock.', 'now', () => 42)
    await expect(provider.query('later', undefined, null)).rejects.toThrow('unknown clock inspect method "later"')
  })
})
