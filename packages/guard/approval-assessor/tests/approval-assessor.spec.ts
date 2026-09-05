import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore, { Session } from '@deepseek-ai/dsh-session'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import * as ApprovalAssessor from '../src/index.ts'

/** Writable provider used to verify the Host settings seam and live reloads. */
class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown>

  constructor(ctx: Context, config: { doc?: Record<string, unknown> } = {}) {
    super(ctx)
    this.doc = structuredClone(config.doc ?? {})
  }

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = structuredClone(section)
    return Promise.resolve()
  }

  pushExternal(doc: Record<string, unknown>): void {
    this.doc = structuredClone(doc)
    this.publish(structuredClone(doc))
  }
}

/**
 * Behavior suite for the mandatory approval assessor: justification screening,
 * user-instruction quoting, and downstream delegation after an audit pass.
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

/** Mount the approval service and the mandatory assessor. */
async function harness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService)
  await ctx.plugin(ApprovalAssessor)
  return ctx
}

/** Mount the assessor with a real in-memory settings provider. */
async function settingsHarness(config?: { doc?: Record<string, unknown> }): Promise<{
  ctx: Context
  provider: MemorySettings
}> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(ApprovalService)
  const providerFiber = ctx.plugin(MemorySettings, config ?? {})
  await providerFiber
  await ctx.plugin(ApprovalAssessor)
  return { ctx, provider: ctx.settings as MemorySettings }
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

describe('settings policy', () => {
  it('registers enabled defaults and an empty extra-phrase list', async () => {
    const { ctx } = await settingsHarness()
    const descriptor = ctx.settings.describe().find(row => String(row.ns) === 'approval-assessor')

    expect(descriptor?.value).toEqual({ enabled: true, extraPhrases: [] })
    await ctx.fiber.dispose()
  })

  it('rejects extra phrases beyond the security limits before persistence', async () => {
    const { ctx, provider } = await settingsHarness()

    await expect(ctx.settings.update(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE, {
      extraPhrases: ['x'.repeat(257)],
    })).rejects.toThrow('expected string length <= 256')
    await expect(ctx.settings.update(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE, {
      extraPhrases: Array.from({ length: 65 }, (_, index) => 'phrase-' + String(index)),
    })).rejects.toThrow('expected array length <= 64')
    await expect(ctx.settings.update(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE, {
      extraPhrases: ['   '],
    })).rejects.toThrow('extraPhrases[0] must contain text')
    expect(provider.doc).toEqual({})
    await ctx.fiber.dispose()
  })

  it('screens a literal extra phrase and supports disabling the assessor', async () => {
    const { ctx } = await settingsHarness()
    const agent = sessionAgent('settings-extra')

    await ctx.settings.update(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE, {
      extraPhrases: ['(do-not-ship)+$'],
    })
    await expect(ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'This contains (DO-NOT-SHIP)+$ guidance.',
    })).resolves.toBe('rejected')
    await expect(ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'do-not-ship does not contain the configured punctuation.',
    })).resolves.toBe('unavailable')

    await ctx.settings.update(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE, { enabled: false })
    await expect(ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this?',
    })).resolves.toBe('unavailable')
    await ctx.fiber.dispose()
  })

  it('refreshes policy from provider-backed document updates', async () => {
    const { ctx, provider } = await settingsHarness()
    const agent = sessionAgent('settings-provider')
    const namespace = String(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE)

    provider.pushExternal({ [namespace]: { enabled: false } })
    await expect(ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this?',
    })).resolves.toBe('unavailable')

    provider.pushExternal({ [namespace]: { enabled: true, extraPhrases: ['provider-deny'] } })
    await expect(ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'provider-deny applies here.',
    })).resolves.toBe('rejected')
    await ctx.fiber.dispose()
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

  it('rejects a request without a justification', async () => {
    const ctx = await harness()
    const agent = sessionAgent('no-reason')
    // Missing justification cannot pass the mandatory audit.
    const outcome = await ctx.approval.request({ agent, toolName: 'read' })
    expect(outcome).toBe('rejected')
  })

  it('rejects a request with only whitespace as its justification', async () => {
    const ctx = await harness()
    const agent = sessionAgent('blank-reason')
    const outcome = await ctx.approval.request({ agent, toolName: 'read', reason: '   \n\t' })
    expect(outcome).toBe('rejected')
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

describe('elevated-tool auditing', () => {
  it('rejects bash approval requests with work-avoidance justification', async () => {
    const ctx = await harness()
    const agent = sessionAgent('bash-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'bash',
      reason: 'Should I skip this dangerous command?',
    })
    expect(outcome).toBe('rejected')
  })

  it('rejects write approval requests with work-avoidance justification', async () => {
    const ctx = await harness()
    const agent = sessionAgent('write-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'write',
      reason: 'This file is out of scope.',
    })
    expect(outcome).toBe('rejected')
  })

  it('rejects edit approval requests with work-avoidance justification', async () => {
    const ctx = await harness()
    const agent = sessionAgent('edit-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'edit',
      reason: 'Known limitation, should I skip?',
    })
    expect(outcome).toBe('rejected')
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
    expect(text).toContain('Mandatory approval audit denied')
  })

  it('skips plugin snapshots that share the user role and quotes the human instruction', async () => {
    // A composed session interleaves runtime-context and reminder snapshots
    // with the human's messages; both are `user/message` rows. Quoting the
    // newest row would redirect the model to a plugin's own text.
    const ctx = await harness()
    const session = Session.create(SessionId('quote-2'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Delete every dead export.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context. Approval policy: ask.' }],
      source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })
    const agent = {
      id: 'quote-2',
      session,
      inject(message: Parameters<Agent['inject']>[0]) {
        session.append('user/message', message, { surfaceOp: 'append' })
      },
    } as Agent

    await ctx.approval.request({ agent, toolName: 'read', reason: 'Known limitation; leave it as-is.' })

    const injected = session.events.filter(
      e => e.type === 'user/message'
        && (e.data as { source?: { plugin?: string } }).source?.plugin === 'approval-assessor',
    ).at(-1) as { data: { content: Array<{ text?: string }> } }
    const text = injected.data.content.map(block => block.text ?? '').join('')
    expect(text).toContain('User instruction: Delete every dead export.')
    expect(text).not.toContain('Current runtime context')
  })

  it('ellipsizes an instruction longer than the excerpt bound', async () => {
    const ctx = await harness()
    const instruction = 'x'.repeat(640)
    const session = Session.create(SessionId('quote-long'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    const agent = {
      id: 'quote-long',
      session,
      inject(message: Parameters<Agent['inject']>[0]) {
        session.append('user/message', message, { surfaceOp: 'append' })
      },
    } as Agent

    await ctx.approval.request({ agent, toolName: 'read', reason: 'This is out of scope.' })

    const injected = session.events.filter(
      e => e.type === 'user/message'
        && (e.data as { source?: { plugin?: string } }).source?.plugin === 'approval-assessor',
    ).at(-1) as { data: { content: Array<{ text?: string }> } }
    const text = injected.data.content.map(block => block.text ?? '').join('')
    expect(text).toContain(`User instruction: ${'x'.repeat(500)}\u2026`)
    expect(text).not.toContain('x'.repeat(501))
  })

  it('omits the quote when the session carries no human instruction', async () => {
    // A delegated subagent turn starts from a plugin-authored prompt.
    const ctx = await harness()
    const session = Session.create(SessionId('quote-3'))
    session.append('turn/start', { turn: 1 })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Delegated task body.' }],
      source: { kind: 'plugin', plugin: 'subagent', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })
    const agent = {
      id: 'quote-3',
      session,
      inject(message: Parameters<Agent['inject']>[0]) {
        session.append('user/message', message, { surfaceOp: 'append' })
      },
    } as Agent

    await ctx.approval.request({ agent, toolName: 'read', reason: 'This is out of scope.' })

    const injected = session.events.filter(
      e => e.type === 'user/message'
        && (e.data as { source?: { plugin?: string } }).source?.plugin === 'approval-assessor',
    ).at(-1) as { data: { content: Array<{ text?: string }> } }
    const text = injected.data.content.map(block => block.text ?? '').join('')
    expect(text).not.toContain('User instruction:')
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
