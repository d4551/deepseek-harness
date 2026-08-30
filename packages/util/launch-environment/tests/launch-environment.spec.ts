import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY, launchEnvironmentOf,
} from '../src/index.ts'

/**
 * The three-layer snapshot, built per test rather than once at module scope so
 * a construction failure reports as a failing test instead of an unloadable file.
 */
const layers = () => createLaunchEnvironmentSnapshot([
  { source: 'process', values: { SHARED: 'from-process', ONLY_PROCESS: 'p' } },
  { source: 'project-env', path: '/work/.env', values: { SHARED: 'from-project', ONLY_PROJECT: 'j' } },
  { source: 'user-env', path: '/home/.dsh/.env', values: { SHARED: 'from-user', ONLY_USER: 'u' } },
])

describe('createLaunchEnvironmentSnapshot', () => {
  it('resolves across every layer, most trusted first, and reports the winning source', () => {
    const layered = layers()
    expect(layered.get('SHARED')).toEqual({ value: 'from-process', source: 'process' })
    expect(layered.get('ONLY_PROJECT')).toEqual({ value: 'j', source: 'project-env', path: '/work/.env' })
    expect(layered.get('ONLY_USER')).toEqual({ value: 'u', source: 'user-env', path: '/home/.dsh/.env' })
    expect(layered.get('ABSENT')).toBeUndefined()
  })

  it('filters layers without changing their trust order', () => {
    const layered = layers()
    // The point of getFrom: a routing field that must never come from a
    // project directory cannot be reached by reordering, only by listing it.
    expect(layered.getFrom('ONLY_PROJECT', ['process', 'user-env'])).toBeUndefined()
    expect(layered.getFrom('SHARED', ['user-env', 'process']))
      .toEqual({ value: 'from-process', source: 'process' })
    expect(layered.getFrom('SHARED', [])).toBeUndefined()
  })

  it('copies each layer, so a later mutation of the source object cannot change it', () => {
    const values: Record<string, string> = { KEY: 'first' }
    const snapshot = createLaunchEnvironmentSnapshot([{ source: 'process', values }])
    values.KEY = 'second'
    values.LATE = 'added'
    expect(snapshot.get('KEY')).toEqual({ value: 'first', source: 'process' })
    expect(snapshot.get('LATE')).toBeUndefined()
  })

  it('keeps an empty value as a present value, for its owner to judge', () => {
    const snapshot = createLaunchEnvironmentSnapshot([{ source: 'process', values: { EMPTY: '' } }])
    expect(snapshot.get('EMPTY')).toEqual({ value: '', source: 'process' })
  })

  it('orders lookups canonically regardless of construction order', () => {
    const reversed = createLaunchEnvironmentSnapshot([
      { source: 'user-env', path: '/u', values: { K: 'u' } },
      { source: 'process', values: { K: 'p' } },
    ])
    expect(reversed.get('K')).toEqual({ value: 'p', source: 'process' })
  })
})

describe('launchEnvironmentOf', () => {
  it('returns the launcher snapshot when the product CLI provided one', () => {
    const layered = layers()
    const ctx = new Context()
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, layered)
    expect(launchEnvironmentOf(ctx)).toBe(layered)
  })

  it('falls back to the inherited environment as the only layer', () => {
    vi.stubEnv('DSH_ENV_SPEC_FALLBACK', 'ambient')
    try {
      const snapshot = launchEnvironmentOf(new Context())
      expect(snapshot.get('DSH_ENV_SPEC_FALLBACK')).toEqual({ value: 'ambient', source: 'process' })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('launch environment name folding and layer paths', () => {
  /** Run `action` with `process.platform` reported as `platform`. */
  const onPlatform = <T>(platform: NodeJS.Platform, action: () => T): T => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...original, value: platform })
    try {
      return action()
    } finally {
      Object.defineProperty(process, 'platform', original)
    }
  }

  it('names the session key the harness stores the snapshot under', () => {
    expect(DSH_LAUNCH_ENVIRONMENT_KEY).toBe('launchEnvironment')
  })

  it('folds names to upper case on Windows and keeps them exact elsewhere', () => {
    const layers = [{ source: 'process' as const, values: { Path: 'from-layer' } }]

    const windows = onPlatform('win32', () => createLaunchEnvironmentSnapshot(layers).get('pATH'))
    expect(windows?.value).toBe('from-layer')

    const posix = onPlatform('linux', () => createLaunchEnvironmentSnapshot(layers))
    expect(posix.get('pATH')).toBeUndefined()
    expect(posix.get('Path')?.value).toBe('from-layer')
  })

  it('does not fold a name that only differs after the first character on POSIX', () => {
    const snapshot = onPlatform('linux', () => createLaunchEnvironmentSnapshot([
      { source: 'process' as const, values: { HOME: 'upper', home: 'lower' } },
    ]))
    expect(snapshot.get('HOME')?.value).toBe('upper')
    expect(snapshot.get('home')?.value).toBe('lower')
  })

  it('carries a layer path onto every entry it answers and omits it otherwise', () => {
    const withPath = createLaunchEnvironmentSnapshot([
      { source: 'project-env', path: '/repo/.env', values: { TOKEN: 'x' } },
    ])
    expect(withPath.get('TOKEN')).toEqual({ value: 'x', source: 'project-env', path: '/repo/.env' })

    const withoutPath = createLaunchEnvironmentSnapshot([
      { source: 'process', values: { TOKEN: 'x' } },
    ])
    expect(withoutPath.get('TOKEN')).toEqual({ value: 'x', source: 'process' })
    expect(Object.hasOwn(withoutPath.get('TOKEN')!, 'path')).toBe(false)
  })

  it('copies each layer value map instead of aliasing the caller object', () => {
    const values: Record<string, string> = { TOKEN: 'first' }
    const snapshot = createLaunchEnvironmentSnapshot([{ source: 'process', values }])
    values.TOKEN = 'mutated'
    values.ADDED = 'later'

    expect(snapshot.get('TOKEN')?.value).toBe('first')
    expect(snapshot.get('ADDED')).toBeUndefined()
  })
})
