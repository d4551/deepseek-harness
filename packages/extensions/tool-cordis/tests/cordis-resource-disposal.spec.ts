import { mkdtemp, open, readFile, rm } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context, FiberState } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished } from 'vitest'

declare module '@deepseek-ai/cordis' {
  interface Context {
    retirementFile: FileHandle
    retirementStage: FileHandle
  }
}

async function composition() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cordis-resource-disposal-'))
  const path = join(root, 'completed.txt')
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  })
  const providerPlugin = {
    name: 'owned-file-provider',
    async apply(inner: Context, config: { path: string }) {
      const file = await open(config.path, 'a')
      inner.effect(function* () {
        yield () => file.close()
        yield inner.provide('retirementFile', file)
      })
    },
  }
  const provider = await ctx.plugin(providerPlugin, { path })
  let activations = 0
  const consumerPlugin = {
    name: 'owned-file-consumer',
    inject: ['retirementFile'],
    apply(inner: Context) {
      activations += 1
      const file = inner.retirementFile
      return async () => {
        await file.appendFile('first\n')
        await file.appendFile('second\n')
      }
    },
  }
  const consumer = await ctx.plugin(consumerPlugin)
  return { ctx, provider, providerPlugin, consumer, consumerPlugin, root, path, activations: () => activations }
}

it('keeps a native provider resource open until simultaneous root disposal drains its consumer', async () => {
  const { ctx, path, activations } = await composition()
  await ctx.fiber.dispose()
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\n')
  expect(activations()).toBe(1)
})

it('joins an already removed consumer during simultaneous explicit sibling disposal', async () => {
  const { ctx, provider, consumer, consumerPlugin, path, activations } = await composition()
  const retiring = consumer.dispose()
  expect(ctx.registry.has(consumerPlugin)).toBe(false)
  await Promise.all([retiring, provider.dispose()])
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\n')
  expect(activations()).toBe(1)
})

it('joins consumer retirement when its removal notification immediately disposes the provider', async () => {
  const { ctx, provider, consumer, consumerPlugin, path, activations } = await composition()
  const disposals: Promise<void>[] = []
  const registrations: boolean[] = []
  ctx.on('internal/plugin', (fiber) => {
    if (fiber.name === consumer.name && fiber.uid === null) {
      registrations.push(ctx.registry.has(consumerPlugin))
      disposals.push(provider.dispose())
    }
  })
  const retirement = consumer.dispose()
  expect(ctx.registry.has(consumerPlugin)).toBe(false)
  await retirement
  await Promise.all(disposals)
  expect(registrations).toEqual([true])
  expect(disposals).toHaveLength(1)
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\n')
  expect(activations()).toBe(1)
})

it('drains a live consumer when its provider is disposed directly', async () => {
  const { provider, path, activations } = await composition()
  await provider.dispose()
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\n')
  expect(activations()).toBe(1)
})

it('retains consumer cleanup after explicit runtime deletion', async () => {
  const { ctx, provider, consumerPlugin, path } = await composition()
  const registrations: boolean[] = []
  ctx.on('internal/plugin', (fiber) => {
    if (fiber.name === consumerPlugin.name && fiber.uid === null) {
      registrations.push(ctx.registry.has(consumerPlugin))
    }
  })
  expect(ctx.registry.delete(consumerPlugin)).toBeDefined()
  expect(ctx.registry.has(consumerPlugin)).toBe(false)
  await provider.dispose()
  expect(registrations).toEqual([false])
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\n')
})

it('drains every retiring instance of the same consumer plugin', async () => {
  const { ctx, consumerPlugin, path, activations } = await composition()
  await ctx.plugin(consumerPlugin)
  await ctx.fiber.dispose()
  expect((await readFile(path, 'utf8')).trimEnd().split('\n').sort())
    .toEqual(['first', 'first', 'second', 'second'])
  expect(activations()).toBe(2)
})

it('preserves isolation while one scope retires and another still uses its own provider', async () => {
  const { ctx, provider, providerPlugin, consumer, consumerPlugin, root, path } = await composition()
  const isolated = ctx.isolate('retirementFile')
  const isolatedPath = join(root, 'isolated.txt')
  await isolated.plugin(providerPlugin, { path: isolatedPath })
  const isolatedConsumer = await isolated.plugin(consumerPlugin)
  await Promise.all([consumer.dispose(), provider.dispose()])
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\n')
  expect(await readFile(isolatedPath, 'utf8')).toBe('')
  expect(isolatedConsumer.state).toBe(FiberState.ACTIVE)
  await ctx.fiber.dispose()
  expect(await readFile(isolatedPath, 'utf8')).toBe('first\nsecond\n')
})

it('drains the old generation and reactivates a live consumer after provider restart', async () => {
  const { ctx, provider, consumer, path, activations } = await composition()
  await provider.restart()
  await consumer.await()
  expect(activations()).toBe(2)
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\n')
  await ctx.fiber.dispose()
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\nfirst\nsecond\n')
})

it('drains nested service dependencies before releasing their common native file', async () => {
  const { ctx, consumer, path } = await composition()
  await consumer.dispose()
  await ctx.plugin({
    name: 'owned-file-stage',
    inject: ['retirementFile'],
    apply(inner) {
      const file = inner.retirementFile
      inner.effect(function* () {
        yield () => file.appendFile('stage\n')
        yield inner.provide('retirementStage', file)
      })
    },
  })
  await ctx.plugin({
    name: 'owned-file-stage-consumer',
    inject: ['retirementStage'],
    apply(inner) {
      const file = inner.retirementStage
      return async () => {
        await file.appendFile('nested-first\n')
        await file.appendFile('nested-second\n')
      }
    },
  })
  await ctx.fiber.dispose()
  expect(await readFile(path, 'utf8')).toBe('first\nsecond\nnested-first\nnested-second\nstage\n')
})

it('disposes a pending required-service cycle without activating either plugin', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  const first = await ctx.plugin({
    inject: ['retirementFile'],
    apply(inner) {
      return inner.provide('retirementStage', inner.retirementFile)
    },
  })
  const second = await ctx.plugin({
    inject: ['retirementStage'],
    apply(inner) {
      return inner.provide('retirementFile', inner.retirementStage)
    },
  })
  expect(first.state).toBe(FiberState.PENDING)
  expect(second.state).toBe(FiberState.PENDING)
  await ctx.fiber.dispose()
  expect(first.state).toBe(FiberState.DISPOSED)
  expect(second.state).toBe(FiberState.DISPOSED)
})
