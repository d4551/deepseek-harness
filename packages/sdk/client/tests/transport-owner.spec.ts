import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createProcessHarnessClient, type HarnessClient, TransportClosedError } from '../src/client.ts'
import { DEFAULT_INITIALIZE_TIMEOUT_MS } from '../src/launch.ts'

const clients: HarnessClient[] = []
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close()
})

function launch(): HarnessClient {
  const client = createProcessHarnessClient({
    command: process.execPath,
    args: ['--unhandled-rejections=strict', fileURLToPath(new URL('./output-close-process.ts', import.meta.url))],
    environment: () => ({}),
    description: 'live protocol peer with closed output',
    initializeTimeoutMs: DEFAULT_INITIALIZE_TIMEOUT_MS,
    shutdownTimeoutMs: 100,
    disposeEofGraceMs: 100,
    disposeGraceMs: 1_000,
  })
  clients.push(client)
  return client
}

async function absent(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000
  while (Date.now() < deadline) {
    const [state] = await Promise.allSettled([Promise.resolve().then(() => process.kill(pid, 0))])
    if (state.status === 'rejected') {
      expect(state.reason).toMatchObject({ code: 'ESRCH' })
      return
    }
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error('transport owner left its child running')
}

describe('SDK transport ownership', () => {
  it('fails subscription-only waits and reaps a still-live peer when protocol output ends', async () => {
    const client = launch()
    const subscription = client.subscribe()
    client.start()
    const ready = await subscription.next()
    expect(ready.method).toBe('ready')
    const pid = ready.params.pid
    if (typeof pid !== 'number') throw new Error('peer did not provide its PID')
    expect(process.kill(pid, 0)).toBe(true)
    const waiting = Promise.allSettled([subscription.next()])
    expect(await client.request('close-output')).toEqual({ closing: true })
    const [failure] = await waiting
    expect(failure.status).toBe('rejected')
    if (failure.status !== 'rejected') throw new Error('subscription did not fail')
    expect(failure.reason).toBeInstanceOf(TransportClosedError)
    expect(failure.reason).toMatchObject({ cause: { message: 'JSON-RPC input closed' } })
    await expect(client.subscribe().next()).rejects.toThrow('JSON-RPC input closed')
    await absent(pid)
    await client.close()
    await expect(subscription.next()).rejects.toThrow('JSON-RPC input closed')
  })

  it('settles pending requests and subscriptions before joining process cleanup', async () => {
    const client = launch()
    const subscription = client.subscribe()
    client.start()
    const ready = await subscription.next()
    const pid = ready.params.pid
    if (typeof pid !== 'number') throw new Error('peer did not provide its PID')
    const failures = await Promise.allSettled([
      subscription.next(), client.request('end-during-request'),
    ])
    for (const failure of failures) {
      expect(failure.status).toBe('rejected')
      if (failure.status !== 'rejected') throw new Error('protocol wait did not fail')
      const reason: unknown = failure.reason
      expect(reason).toBeInstanceOf(TransportClosedError)
      if (!(reason instanceof Error)) throw new Error('protocol failure is not an Error')
      expect(reason.message).toContain('JSON-RPC input closed')
    }
    await absent(pid)
    await client.close()
  })
})
