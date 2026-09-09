import { expect, it, onTestFinished, vi } from 'vitest'
import { ConnectionController } from '../src/client/connection.ts'

const config = { backoffBaseMs: 10, backoffMaxMs: 10, generationReadyTimeoutMs: 20 }

it('retries a readiness timeout even when the carrier has not settled after abort', async () => {
  const stalled = Promise.withResolvers<undefined>()
  const homes: string[] = []
  const signals: AbortSignal[] = []
  const controller = new ConnectionController((signal, ready) => {
    signals.push(signal)
    if (signals.length === 1) return stalled.promise
    ready({ home: '/connected' })
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }, { onConnected: (host) => { homes.push(host.home) } }, config)
  onTestFinished(() => { controller.stop(); stalled.resolve(undefined) })
  controller.start()
  await vi.waitFor(() => { expect(homes).toEqual(['/connected']) })
  expect(signals).toHaveLength(2)
  expect(signals[0]?.aborted).toBe(true)
  expect(signals[1]?.aborted).toBe(false)
})

it('keeps exactly one generation after stopping and immediately restarting', async () => {
  const signals: AbortSignal[] = []
  const homes: string[] = []
  const controller = new ConnectionController((signal, ready) => {
    signals.push(signal)
    ready({ home: `/generation-${signals.length}` })
    return new Promise((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
  }, { onConnected: (host) => { homes.push(host.home) } }, config)
  onTestFinished(() => { controller.stop() })
  controller.start()
  await vi.waitFor(() => { expect(homes).toHaveLength(1) })
  controller.stop()
  controller.start()
  await new Promise(resolve => setTimeout(resolve, 80))
  expect(signals).toHaveLength(2)
  expect(signals.filter(signal => !signal.aborted)).toHaveLength(1)
  expect(homes).toEqual(['/generation-1', '/generation-2'])
})
