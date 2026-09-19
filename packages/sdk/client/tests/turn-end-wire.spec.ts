/** Wire `turn/end` must reject a present non-object `data` as SdkProtocolError. */

import { afterEach, describe, expect, it } from 'vitest'
import { DeepSeekHarness } from '../src/index.ts'
import { createProcessDeepSeekHarness } from '../src/api.ts'
import type { RuntimeProcessOptions } from '../src/launch.ts'
import { fileURLToPath } from 'node:url'

const fakeRuntime = fileURLToPath(new URL('./fake-runtime.ts', import.meta.url))
const cleanups: (() => Promise<void>)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup()
})

function harnessWith(env: Record<string, string>): DeepSeekHarness {
  const options: RuntimeProcessOptions = {
    command: process.execPath,
    args: [fakeRuntime],
    environment: () => {
      const inherited: Record<string, string> = {}
      for (const [name, value] of Object.entries(process.env)) {
        if (value !== undefined) inherited[name] = value
      }
      return { ...inherited, ...env }
    },
    description: 'scripted fake runtime',
    initializeTimeoutMs: 5_000,
  }
  const harness = createProcessDeepSeekHarness(options)
  cleanups.push(() => harness.close())
  return harness
}

describe('turn/end wire data', () => {
  it('rejects a null data member as a protocol error', async () => {
    const harness = harnessWith({ FAKE_MALFORMED_REASON: 'null-data' })
    await expect(harness.run('bad-reason')).rejects.toThrow(/turn\/end carried malformed data/)
  })
})
