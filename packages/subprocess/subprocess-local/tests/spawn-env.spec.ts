import { describe, expect, it, vi } from 'vitest'
import { spawnSubprocess } from '../src/spawn.ts'
import { finish, spec } from './spawn-support.ts'

describe('environment hardening', () => {
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
