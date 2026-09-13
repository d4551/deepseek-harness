import { describe, expect, it, vi } from 'vitest'
import { childEnv, LOCAL_ENVIRONMENT_ISOLATION_SUPPORTED, spawnSubprocess } from '../src/spawn.ts'
import { finish, spec } from './spawn-support.ts'

describe('environment hardening', () => {
  it.each([{}, { EXPLICIT: 'kept', DSH_SESSION_ID: 'intentional' }])(
    'starts an isolated process with exactly the supplied environment %j',
    async (env) => {
      const request = spec('unused', {
        argv: ['/usr/bin/env', '-0'],
        env,
        environmentPolicy: 'isolated',
      })
      if (process.platform === 'win32') {
        expect(LOCAL_ENVIRONMENT_ISOLATION_SUPPORTED).toBe(false)
        expect(() => childEnv(env, 'isolated')).toThrow('exact environment isolation is unavailable')
        expect(() => spawnSubprocess(request)).toThrow('exact environment isolation is unavailable')
        return
      }
      expect(LOCAL_ENVIRONMENT_ISOLATION_SUPPORTED).toBe(true)
      expect(childEnv(env, 'isolated')).toEqual(env)
      const handle = spawnSubprocess(request)
      const result = await finish(handle)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.text).toBe(Object.entries(env).map(([key, value]) => `${key}=${value}\0`).join(''))
      await expect(handle.waitForExit()).resolves.toBe(true)

      const nodeHandle = spawnSubprocess({
        ...request,
        argv: [process.execPath, '-e', 'process.stdout.write(JSON.stringify(process.env))'],
      })
      const nodeResult = await finish(nodeHandle)
      expect(nodeResult.exitCode).toBe(0)
      const environment: unknown = JSON.parse(nodeResult.stdout.text)
      expect(environment).toMatchObject(env)
      expect(environment).not.toHaveProperty('PATH')
      expect(environment).not.toHaveProperty('HOME')
      await expect(nodeHandle.waitForExit()).resolves.toBe(true)
    },
  )

  it('rejects an unrecognized environment policy before spawning', () => {
    const request = spec('unused')
    Reflect.set(request, 'environmentPolicy', 'unrecognized')
    expect(() => spawnSubprocess(request)).toThrow('subprocess: invalid environment policy')
  })

  it('scrubs credential-shaped and ambient DSH env vars from child processes', async () => {
    vi.stubEnv('DSH_TEST_API_KEY', 'super-secret')
    vi.stubEnv('DSH_TEST_TOKEN', 'also-secret')
    vi.stubEnv('SUBPROCESS_TEST_PASSWORD', 'password-secret')
    vi.stubEnv('DSH_TEST_PLAIN', 'visible')
    const result = await finish(spawnSubprocess(spec(
      'echo "[${DSH_TEST_API_KEY:-absent}|${DSH_TEST_TOKEN:-absent}|${SUBPROCESS_TEST_PASSWORD:-absent}|${DSH_TEST_PLAIN:-absent}]"',
    )))
    expect(result.stdout.text.trim()).toBe('[absent|absent|absent|absent]')
    vi.unstubAllEnvs()
  })

  it('forwards explicit DSH_* env entries while scrubbing ambient ones', async () => {
    // Both facts through one explicit map: the ambient DSH_STALE is dropped by
    // the scrub, and the deliberately supplied current values merge after it.
    vi.stubEnv('DSH_STALE', 'old-value')
    const result = await finish(spawnSubprocess(spec('echo "[${DSH_STALE:-absent}|$DSH_SHELL|$DSH_SESSION_ID]"', {
      env: { DSH_SHELL: '1', DSH_SESSION_ID: 'current-session' },
    })))
    expect(result.stdout.text.trim()).toBe('[absent|1|current-session]')
    vi.unstubAllEnvs()
  })
})
