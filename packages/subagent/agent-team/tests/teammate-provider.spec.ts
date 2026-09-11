import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { expect, it, onTestFinished } from 'vitest'
import { teammateProvider } from '../src/teammate-provider.ts'

async function registry() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SubagentService)
  return ctx
}

it('discovers providers by continuation and context capabilities under custom names', async () => {
  const ctx = await registry()
  await ctx.plugin(SubagentSpawn, { providerName: 'fresh-worker' })
  await ctx.plugin(SubagentFork, { providerName: 'history-worker' })
  expect(teammateProvider(ctx, { context: 'fresh' })).toBe(ctx.subagents.getProvider('fresh-worker'))
  expect(teammateProvider(ctx, { context: 'fork' })).toBe(ctx.subagents.getProvider('history-worker'))
})

it('rejects absent, ambiguous, and removed providers instead of selecting by registration order', async () => {
  const ctx = await registry()
  expect(() => teammateProvider(ctx, { context: 'fresh' })).toThrow('found 0')
  await ctx.plugin(SubagentSpawn, { providerName: 'first' })
  const second = await ctx.plugin(SubagentSpawn, { providerName: 'second' })
  expect(() => teammateProvider(ctx, { context: 'fresh' })).toThrow('found 2')
  expect(teammateProvider(ctx, { context: 'fresh', provider: 'second' })).toBe(ctx.subagents.getProvider('second'))
  await second.dispose()
  expect(() => teammateProvider(ctx, { context: 'fresh', provider: 'second' })).toThrow('not registered')
  expect(teammateProvider(ctx, { context: 'fresh' })).toBe(ctx.subagents.getProvider('first'))
})

it('rejects context mismatches and invalid configured provider names', async () => {
  const ctx = await registry()
  await ctx.plugin(SubagentSpawn, { providerName: 'fresh-worker' })
  await ctx.plugin(SubagentFork, { providerName: 'history-worker' })
  expect(() => teammateProvider(ctx, { context: 'fork', provider: 'fresh-worker' })).toThrow('cannot create a fork')
  expect(() => teammateProvider(ctx, { context: 'fresh', provider: 'history-worker' })).toThrow('cannot create a fresh')
  expect(() => teammateProvider(ctx, { context: 'fresh', provider: ' ' })).toThrow('must be non-empty')
  expect(() => teammateProvider(ctx, { context: 'fresh', provider: 'x'.repeat(201) })).toThrow('exceeds 200')
})
