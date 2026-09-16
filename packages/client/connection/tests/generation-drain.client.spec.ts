import { Context } from '@deepseek-ai/cordis'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import { expect, it, onTestFinished } from 'vitest'
import { ConnectionController } from '../src/client/connection.ts'
import { apply, type ClientTransportHooks } from '../src/client/index.ts'
import { apply as applyGateway, inject as gatewayInject } from '../../../api/gateway/src/client/index.ts'
import { serveGenerations } from './generation-network.client.ts'

const config = { backoffBaseMs: 1, backoffMaxMs: 1 }

it('awaits real source cleanup after aborting an active generation', async () => {
  const network = await serveGenerations()
  const ready = Promise.withResolvers<undefined>()
  const controller = new ConnectionController(network.source, { onConnected: () => { ready.resolve(undefined) } }, config)
  network.owners.push(() => controller.stop())
  controller.start()
  await ready.promise
  let stopped = false
  const stopping = Promise.resolve(controller.stop()).then(() => { stopped = true })
  const retiring = await network.request('/retire/1')
  expect(stopped).toBe(false)
  retiring.end('released')
  await stopping
  expect(stopped).toBe(true)
})

it('retries readiness while retaining the timed-out source until disposal', async () => {
  const network = await serveGenerations(true)
  const ready = Promise.withResolvers<undefined>()
  const controller = new ConnectionController(network.source, {
    onConnected: () => { ready.resolve(undefined) },
  }, { ...config, generationReadyTimeoutMs: 100 })
  network.owners.push(() => controller.stop())
  controller.start()
  const first = await network.request('/retire/1')
  await ready.promise
  let stopped = false
  const stopping = Promise.resolve(controller.stop()).then(() => { stopped = true })
  const second = await network.request('/retire/2')
  const secondFinished = new Promise<void>((resolve) => { second.once('finish', resolve) })
  second.end('released')
  await secondFinished
  expect(stopped).toBe(false)
  first.end('released')
  await stopping
})

it('keeps prior drainage owned across immediate stop and restart', async () => {
  const network = await serveGenerations()
  const ready = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
  let generations = 0
  const controller = new ConnectionController(network.source, {
    onConnected: () => {
      ready[generations]?.resolve(undefined)
      generations += 1
    },
  }, config)
  network.owners.push(() => controller.stop())
  controller.start()
  await ready[0]?.promise
  let firstStopped = false
  const firstStop = Promise.resolve(controller.stop()).then(() => { firstStopped = true })
  controller.start()
  const first = await network.request('/retire/1')
  await ready[1]?.promise
  let secondStopped = false
  const secondStop = Promise.resolve(controller.stop()).then(() => { secondStopped = true })
  const second = await network.request('/retire/2')
  const secondFinished = new Promise<void>((resolve) => { second.once('finish', resolve) })
  second.end('released')
  await secondFinished
  expect(firstStopped).toBe(false)
  expect(secondStopped).toBe(false)
  first.end('released')
  await Promise.all([firstStop, secondStop])
})

it('awaits source cleanup through the real Gateway and Connection plugin lifecycle', async () => {
  const network = await serveGenerations(false, true)
  const transport: ClientTransportHooks = {
    fetch,
    async *openStream(_endpoint, _payload, signal) {
      for await (const frame of network.stream(signal)) yield JSON.parse(frame)
    },
  }
  Object.assign(globalThis, { __DSH_TRANSPORT__: transport })
  onTestFinished(() => { Reflect.deleteProperty(globalThis, '__DSH_TRANSPORT__') })
  const ctx = new Context()
  const fiber = ctx.plugin({ apply })
  network.owners.push(() => ctx.fiber.dispose())
  await fiber
  await ctx.plugin(TypertRegistry)
  const ready = Promise.withResolvers<undefined>()
  ctx.on('connection/reset', () => { ready.resolve(undefined) })
  const gateway = ctx.plugin({ apply: applyGateway, inject: gatewayInject })
  await gateway
  await ready.promise
  let disposed = false
  const disposal = gateway.dispose().then(() => { disposed = true })
  const retiring = await network.request('/retire/1')
  expect(disposed).toBe(false)
  retiring.end('released')
  await disposal
  expect(disposed).toBe(true)
})
