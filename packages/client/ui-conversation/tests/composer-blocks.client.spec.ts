import { SessionId } from '@deepseek-ai/dsh-session/types'
import { expect, it, onTestFinished } from 'vitest'
import type { ComposerBlock } from '../src/client/contract/composer-blocks.ts'
import { ComposerBlockRegistry } from '../src/client/input/blocks.ts'

it('isolates session blocks and notifies subscribers only when the displayed reason changes', () => {
  const registry = new ComposerBlockRegistry()
  const firstId = SessionId('first-conversation')
  const secondId = SessionId('second-conversation')
  const first = registry.storeFor(firstId)
  const second = registry.storeFor(secondId)
  const changes: (ComposerBlock | undefined)[] = []
  onTestFinished(first.subscribe(() => { changes.push(first.getSnapshot()) }))
  expect(registry.storeFor(firstId)).toBe(first)
  expect(first).not.toBe(second)
  expect(first.getSnapshot()).toBeUndefined()
  registry.set(firstId, undefined)
  expect(changes).toEqual([])
  registry.set(firstId, { reason: 'Choose a model' })
  const original = first.getSnapshot()
  expect(changes).toEqual([{ reason: 'Choose a model' }])
  registry.set(firstId, { reason: 'Choose a model' })
  expect(first.getSnapshot()).toBe(original)
  expect(changes).toEqual([{ reason: 'Choose a model' }])
  registry.set(secondId, { reason: 'Connect a workspace' })
  expect(first.getSnapshot()).toBe(original)
  expect(second.getSnapshot()).toEqual({ reason: 'Connect a workspace' })
  registry.set(firstId, { reason: '模型不可用' })
  registry.set(firstId, undefined)
  expect(changes).toEqual([{ reason: 'Choose a model' }, { reason: '模型不可用' }, undefined])
  expect(second.getSnapshot()).toEqual({ reason: 'Connect a workspace' })
})

it('starts a reopened session with an independent empty store and releases observer ownership', () => {
  const registry = new ComposerBlockRegistry()
  const sessionId = SessionId('reopened-conversation')
  registry.set(sessionId, { reason: 'Workspace unavailable' })
  const released = registry.storeFor(sessionId)
  const changes: (ComposerBlock | undefined)[] = []
  const unsubscribe = released.subscribe(() => { changes.push(released.getSnapshot()) })
  onTestFinished(unsubscribe)
  registry.forget(sessionId)
  const reopened = registry.storeFor(sessionId)
  expect(reopened).not.toBe(released)
  expect(reopened.getSnapshot()).toBeUndefined()
  registry.set(sessionId, { reason: 'Select a provider' })
  expect(reopened.getSnapshot()).toEqual({ reason: 'Select a provider' })
  expect(released.getSnapshot()).toEqual({ reason: 'Workspace unavailable' })
  expect(changes).toEqual([])
  unsubscribe()
  released.set(undefined)
  expect(changes).toEqual([])
  expect(reopened.getSnapshot()).toEqual({ reason: 'Select a provider' })
})
