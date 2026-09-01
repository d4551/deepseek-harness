import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as ApprovalAssessor from '../src/index.ts'
import type { Config } from '../src/index.ts'

/**
 * Behavior suite for the approval assessor guard: evasion detection, safety
 * gate passthrough, settings toggle, extra patterns, user instruction quoting,
 * and delegation to downstream answerers.
 */

interface SeedEvent {
  type: 'user/message'
  data: UserMessage
}

/** Minimal agent stand-in with a real session for event lookups. */
function sessionAgent(id: string, seedEvents: SeedEvent[] = []): Agent {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  for (const event of seedEvents) {
    session.append('user/message', event.data, { surfaceOp: 'append' })
  }
  return {
    id,
    session,
    inject(message: Parameters<Agent['inject']>[0]) {
      session.append('user/message', message, { surfaceOp: 'append' })
    },
  } as Agent
}

/** Mount the approval service + assessor plugin. */
async function harness(config: Config = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ApprovalAssessor, config)
  return ctx
}

describe('plugin mounting', () => {
  it('registers an approval/request listener that intercepts evasion', async () => {
    const ctx = await harness()
    // Verify the listener is registered by checking that a non-evasion request
    // still delegates (proving the listener ran and chose to delegate)
    const agent = sessionAgent('mount-check')
    let listenerRan = false
    // Register AFTER the assessor — if the assessor's listener runs first and
    // delegates, this one runs second
    ctx.on('approval/request', async (_req, next) => {
      listenerRan = true
      return next()
    })
    await ctx.approval.request({ agent, toolName: 'read', reason: 'legitimate' })
    expect(listenerRan).toBe(true)
  })
})

describe('evasion detection', () => {
  it('rejects an approval request whose reason matches a work-avoidance pattern', async () => {
    const ctx = await harness()
    const agent = sessionAgent('evade-1')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this file since it is pre-existing code?',
    })

    expect(outcome).toBe('rejected')
  })

  it('rejects "out of scope" evasion', async () => {
    const ctx = await harness()
    const agent = sessionAgent('evade-2')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'grep',
      reason: 'This violation is out of scope for the current task.',
    })

    expect(outcome).toBe('rejected')
  })

  it('rejects "known limitation" evasion', async () => {
    const ctx = await harness()
    const agent = sessionAgent('evade-3')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'glob',
      reason: 'This is a known limitation of the framework.',
    })

    expect(outcome).toBe('rejected')
  })

  it('rejects "leave as-is" evasion', async () => {
    const ctx = await harness()
    const agent = sessionAgent('evade-4')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I leave this as-is since it already works?',
    })

    expect(outcome).toBe('rejected')
  })

  it('passes through when no reason is provided', async () => {
    const ctx = await harness()
    const agent = sessionAgent('no-reason')
    // No downstream answerer → unavailable (the assessor delegated)
    const outcome = await ctx.approval.request({ agent, toolName: 'read' })
    expect(outcome).toBe('unavailable')
  })

  it('passes through when reason does not match any evasion pattern', async () => {
    const ctx = await harness()
    const agent = sessionAgent('legit-reason')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'File requires elevated permissions to read.',
    })
    // Delegated to downstream → unavailable (no answerer composed)
    expect(outcome).toBe('unavailable')
  })
})

describe('safety gate passthrough', () => {
  it('always passes through bash approval requests regardless of reason', async () => {
    const ctx = await harness()
    const agent = sessionAgent('bash-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'bash',
      reason: 'Should I skip this dangerous command?',
    })
    // Delegated despite matching evasion text — bash is a safety gate tool
    expect(outcome).toBe('unavailable')
  })

  it('always passes through write approval requests regardless of reason', async () => {
    const ctx = await harness()
    const agent = sessionAgent('write-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'write',
      reason: 'This file is out of scope.',
    })
    expect(outcome).toBe('unavailable')
  })

  it('always passes through edit approval requests regardless of reason', async () => {
    const ctx = await harness()
    const agent = sessionAgent('edit-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'edit',
      reason: 'Known limitation, should I skip?',
    })
    expect(outcome).toBe('unavailable')
  })
})

describe('settings toggle', () => {
  it('delegates every request when disabled via config', async () => {
    const ctx = await harness({ enabled: false })
    const agent = sessionAgent('disabled-1')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this entirely?',
    })
    // Disabled → delegated → unavailable
    expect(outcome).toBe('unavailable')
  })
})

describe('extra patterns', () => {
  it('rejects on a user-supplied extra pattern', async () => {
    const ctx = await harness({ extraPatterns: ['\\bcustom[- ]?evasion\\b'] })
    const agent = sessionAgent('extra-1')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'This is a custom-evasion attempt.',
    })
    expect(outcome).toBe('rejected')
  })

  it('does not reject when extra pattern does not match', async () => {
    const ctx = await harness({ extraPatterns: ['\\bxyzzy\\b'] })
    const agent = sessionAgent('extra-2')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Normal legitimate reason.',
    })
    expect(outcome).toBe('unavailable')
  })
})

describe('user instruction quoting', () => {
  it('includes the last user instruction in the rejection context', async () => {
    const ctx = await harness()
    const session = Session.create(SessionId('quote-1'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Fix all lint violations in src/utils.ts' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const agent = {
      id: 'quote-1',
      session,
      inject(message: Parameters<Agent['inject']>[0]) {
        session.append('user/message', message, { surfaceOp: 'append' })
      },
    } as Agent

    await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this pre-existing issue?',
    })

    // The rejection injects a user message into the agent's session
    const injected = session.events.filter(
      e => e.type === 'user/message'
        && (e.data as { source?: { kind?: string } }).source?.kind === 'plugin',
    )
    expect(injected.length).toBeGreaterThanOrEqual(1)
    const lastInjected = injected.at(-1) as { data: { content: Array<{ text?: string }> } }
    const text = lastInjected.data.content.map(b => b.text ?? '').join('')
    expect(text).toContain('Fix all lint violations in src/utils.ts')
    expect(text).toContain('work-avoidance')
  })
})

describe('downstream delegation', () => {
  it('lets a downstream answerer decide when the request is not evasion', async () => {
    const ctx = await harness()
    const agent = sessionAgent('delegate-1')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Legitimate access requiring approval.',
    })

    expect(outcome).toBe('allowed-once')
  })

  it('does not reach downstream when evasion is detected', async () => {
    const ctx = await harness()
    const agent = sessionAgent('no-delegate-1')
    let downstreamCalled = false
    ctx.on('approval/request', () => {
      downstreamCalled = true
      return Promise.resolve<ApprovalOutcome>('allowed-once')
    })

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this?',
    })

    expect(outcome).toBe('rejected')
    expect(downstreamCalled).toBe(false)
  })
})
