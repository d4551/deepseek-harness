import { describe, expect, it } from 'vitest'
import { createCssVariablesTheme, createHighlighterCoreSync } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { GrammarLoads } from '../src/markdown/highlight-loads.ts'
import type { LangModule } from '../src/markdown/highlight-grammars.ts'

function highlighter() {
  return createHighlighterCoreSync({
    themes: [createCssVariablesTheme({ name: 'css-variables' })],
    langs: [],
    engine: createJavaScriptRegexEngine({ forgiving: true }),
  })
}

describe('grammar attempt ownership', () => {
  it('retains one rejected import and never retries or reports again during ordinary requests', async () => {
    using instance = highlighter()
    const first = Promise.withResolvers<LangModule>()
    const failed = Promise.withResolvers<Error>()
    let attempts = 0
    let registrations = 0
    const failures: Error[] = []
    const loads = new GrammarLoads(() => instance, new Map([
      ['python', () => {
        attempts += 1
        return first.promise
      }],
    ]), {
      loaded() { registrations += 1 },
      failed(error) { failures.push(error); failed.resolve(error) },
    })
    expect(loads.ensure('python')).toBe(false)
    expect(loads.ensure('python')).toBe(false)
    await Promise.resolve()
    expect(attempts).toBe(1)
    const cause = new Error('grammar transfer interrupted')
    first.reject(cause)
    const error = await failed.promise
    expect(error.message).toBe('Could not load syntax grammar "python"')
    expect(error.cause).toBe(cause)
    expect(failures).toEqual([error])
    expect(loads.failure('python')).toBe(error)
    expect(registrations).toBe(0)
    expect(instance.getLoadedLanguages()).not.toContain('python')
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(attempts).toBe(1)
    expect(failures).toEqual([error])
    expect(Array.from({ length: 20 }, () => loads.ensure('python'))).toEqual(Array(20).fill(false))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(attempts).toBe(1)
    expect(registrations).toBe(0)
    expect(failures).toEqual([error])
    expect(loads.failure('python')).toBe(error)
  })

  it('owns synchronous loader failures and independently completes another language', async () => {
    using instance = highlighter()
    const failure = Promise.withResolvers<Error>()
    const success = Promise.withResolvers<undefined>()
    const cause = new Error('grammar loader rejected its input')
    let attempts = 0
    const loads = new GrammarLoads(() => instance, new Map([
      ['python', () => { attempts += 1; throw cause }],
      ['json', () => import('@shikijs/langs/json')],
    ]), { loaded() { success.resolve(undefined) }, failed: failure.resolve })
    expect(loads.ensure('python')).toBe(false)
    expect(loads.ensure('json')).toBe(false)
    const [error] = await Promise.all([failure.promise, success.promise])
    expect(error.cause).toBe(cause)
    expect(attempts).toBe(1)
    expect(loads.ensure('json')).toBe(true)
    expect(instance.getLoadedLanguages()).not.toContain('python')
    expect(instance.getLoadedLanguages()).toContain('json')
  })

  it('keeps a fulfilled import pending until registration and refuses a different grammar', async () => {
    using instance = highlighter()
    const failure = Promise.withResolvers<Error>()
    let attempts = 0
    let registrations = 0
    const loads = new GrammarLoads(() => instance, new Map([
      ['python', () => {
        attempts += 1
        return import('@shikijs/langs/json')
      }],
    ]), {
      loaded() { registrations += 1 },
      failed: failure.resolve,
    })
    expect(loads.ensure('python')).toBe(false)
    const error = await failure.promise
    expect(error.cause).toEqual(new Error('Loaded syntax grammar does not register "python"'))
    expect(registrations).toBe(0)
    expect(loads.ensure('python')).toBe(false)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(loads.failure('python')).toBe(error)
    expect(registrations).toBe(0)
    expect(attempts).toBe(1)
  })

  it('shares concurrent requests and does not reload an already registered grammar', async () => {
    using instance = highlighter()
    const imported = Promise.withResolvers<LangModule>()
    const success = Promise.withResolvers<undefined>()
    const failures: Error[] = []
    let attempts = 0
    let registrations = 0
    const loads = new GrammarLoads(() => instance, new Map([
      ['python', () => { attempts += 1; return imported.promise }],
    ]), {
      loaded() { registrations += 1; success.resolve(undefined) },
      failed(error) { failures.push(error) },
    })
    expect(loads.ensure('json')).toBe(true)
    expect(loads.failure('json')).toBeUndefined()
    expect(attempts).toBe(0)
    expect(Array.from({ length: 20 }, () => loads.ensure('python'))).toEqual(Array(20).fill(false))
    await Promise.resolve()
    expect(attempts).toBe(1)
    imported.resolve(await import('@shikijs/langs/python'))
    await success.promise
    expect(Array.from({ length: 20 }, () => loads.ensure('python'))).toEqual(Array(20).fill(true))
    expect(attempts).toBe(1)
    expect(registrations).toBe(1)
    expect(failures).toEqual([])
    expect(loads.failure('python')).toBeUndefined()
    const tokens = instance.codeToTokens('print(42)', { lang: 'python', theme: 'css-variables' }).tokens
    expect(tokens.flat().map(token => token.content).join('')).toBe('print(42)')
    expect(tokens.flat().length).toBeGreaterThan(1)
  })

  it('recovers a failed grammar when another module registers it without repeating the failed import', async () => {
    using instance = highlighter()
    const failed = Promise.withResolvers<Error>()
    const loaded = Promise.withResolvers<undefined>()
    const cause = new Error('CSS grammar transfer interrupted')
    let attempts = 0
    let registrations = 0
    const failures: Error[] = []
    const snapshots: (Error | undefined)[] = []
    const loads = new GrammarLoads(() => instance, new Map([
      ['css', () => { attempts += 1; throw cause }],
      ['html', () => import('@shikijs/langs/html')],
    ]), {
      loaded() {
        registrations += 1
        snapshots.push(loads.failure('css'))
        loaded.resolve(undefined)
      },
      failed(error) { failures.push(error); failed.resolve(error) },
    })
    expect(loads.ensure('css')).toBe(false)
    const error = await failed.promise
    expect(loads.failure('css')).toBe(error)
    expect(error.cause).toBe(cause)
    expect(loads.ensure('css')).toBe(false)
    expect(loads.ensure('html')).toBe(false)
    await loaded.promise
    expect(instance.getLoadedLanguages()).toContain('css')
    expect(snapshots).toEqual([undefined])
    expect(loads.failure('css')).toBeUndefined()
    expect(Array.from({ length: 20 }, () => loads.ensure('css'))).toEqual(Array(20).fill(true))
    expect(attempts).toBe(1)
    expect(registrations).toBe(1)
    expect(failures).toEqual([error])
    const tokens = instance.codeToTokens('a { color: red; }', { lang: 'css', theme: 'css-variables' }).tokens
    expect(tokens.flat().map(token => token.content).join('')).toBe('a { color: red; }')
    expect(tokens.flat().length).toBeGreaterThan(1)
  })
})
