import { describe, expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
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

/** Create a real idle agent with a durable instruction history. */
async function sessionAgent(ctx: Context, id: string, seedEvents: SeedEvent[] = []): Promise<Agent> {
  const { agent } = await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: 'reviewer', model: 'm' } })
  const session = agent.session
  session.append('turn/start', { turn: 1 })
  for (const event of seedEvents) {
    session.append('user/message', event.data, { surfaceOp: 'append' })
  }
  return agent
}

function redirects(agent: Agent): string[] {
  return agent.inbox.nextStep.flatMap(message => message.source.kind === 'plugin' && message.source.plugin === 'approval-assessor'
    ? message.content.flatMap(block => block.type === 'text' ? [block.text] : []) : [])
}

/** Mount the approval service and the mandatory assessor. */
async function harness(): Promise<Context> {
  return (await settingsHarness()).ctx
}

/** Mount the assessor with a real in-memory settings provider. */
async function settingsHarness(config?: { doc?: Record<string, unknown> }): Promise<{
  ctx: Context
  provider: MemorySettings
}> {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionStore)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ApprovalService)
  const providerFiber = ctx.plugin(MemorySettings, config ?? {})
  await providerFiber
  await ctx.plugin(ApprovalAssessor)
  const provider = ctx.settings
  if (!(provider instanceof MemorySettings)) throw new Error('Settings provider did not mount')
  return { ctx, provider }
}

describe('plugin mounting', () => {
  it('registers an approval/request listener that intercepts evasion', async () => {
    const ctx = await harness()
    // Verify the listener is registered by checking that a non-evasion request
    // still delegates (proving the listener ran and chose to delegate)
    const agent = await sessionAgent(ctx, 'mount-check')
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
  it('rejects an empty normalized composition phrase without a settings provider', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await ctx.plugin(ApprovalService)
    await expect(ctx.plugin(ApprovalAssessor, { extraPhrases: ['\u200b'] })).rejects.toThrow('extraPhrases[0] must contain text')
  })

  it('keeps one schema for composition and persisted policy', async () => {
    expect(ApprovalAssessor.name).toBe('approval-assessor')
    expect(ApprovalAssessor.inject).toEqual(['approval'])
    expect(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE).toBe('approval-assessor')
    const { ctx } = await settingsHarness()
    const descriptor = ctx.settings.describe().find(row => row.ns === ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE)
    expect(descriptor?.schema).toEqual(ApprovalAssessor.Config.toJSON())
    expect(ApprovalAssessor.Config({})).toEqual({ enabled: true, extraPhrases: [] })
    const extraPhrases = Array.from({ length: 64 }, (_, index) => String(index).padEnd(256, 'x'))
    expect(ApprovalAssessor.Config({ extraPhrases })).toEqual({ enabled: true, extraPhrases })
    expect(() => ApprovalAssessor.Config({ extraPhrases: [''] })).toThrow()
  })
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
    const agent = await sessionAgent(ctx, 'settings-extra')

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
    const agent = await sessionAgent(ctx, 'settings-provider')
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
  it.each([
    'should i skip this', 'can i defer this', 'may i postpone this', 'shall i omit this',
    'do you want me to avoid this', 'would you like me to skip this',
    'is it ok to defer this', 'is it okay to postpone this', 'permission to omit this',
    'ask permission', 'asking permission', 'ask for permission', 'asking for permission',
    'not my code', 'not mine to fix', 'preexisting issue', 'pre-existing error', 'pre existing violation',
    'preexisting build pipeline issue',
    'out of scope', 'already exist', 'already exists', 'already done', 'already handled', 'already fixed', 'already implemented',
    'known bug', 'future work', 'separate ticket', 'too risky', 'not worth fixing', 'good enough',
    'leave asis', 'leave as-is', 'leave as is', 'leave it as-is', 'leave them as is', 'skip for now',
  ])('blocks the screened justification before a granting answerer: %s', async (reason) => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'screen')
    let calls = 0
    ctx.on('approval/request', () => { calls += 1; return Promise.resolve<ApprovalOutcome>('allowed-once') })
    await expect(ctx.approval.request({ agent, toolName: 'bash', reason })).resolves.toBe('rejected')
    expect(calls).toBe(0)
    expect(redirects(agent)).toHaveLength(1)
    expect(agent.inbox.nextStep[0]?.source).toEqual({ kind: 'plugin', plugin: 'approval-assessor', form: 'notice', summary: 'mandatory-audit-rejected' })
  })

  it.each(['The task requires reading the file.', 'Run the entire validation suite.', 'Use the configured build command.'])('leaves authorized-action review to the answerer: %s', async (reason) => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'clear')
    ctx.on('approval/request', () => Promise.resolve<ApprovalOutcome>('allowed-once'))
    await expect(ctx.approval.request({ agent, toolName: 'bash', reason })).resolves.toBe('allowed-once')
    expect(redirects(agent)).toEqual([])
  })
  it.each([
    'Ｓｈｏｕｌｄ Ｉ ｓｋｉｐ the tests?',
    'Should I sk\u200bip the tests?',
    'pre-existing\n\nviolation',
    'out\t of\n scope',
    '\u200b\u2060\ufeff',
  ])('rejects Unicode and multiline evasion before a downstream grant: %s', async (reason) => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'normalized')
    let downstream = 0
    ctx.on('approval/request', () => { downstream += 1; return Promise.resolve<ApprovalOutcome>('allowed-once') })
    await expect(ctx.approval.request({ agent, toolName: 'bash', reason })).resolves.toBe('rejected')
    expect(downstream).toBe(0)
    await ctx.fiber.dispose()
  })

  it('normalizes configured phrases and reasons identically', async () => {
    const { ctx } = await settingsHarness()
    await ctx.settings.update(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE, { extraPhrases: ['Ｄｅｌａｙ\t\ttests'] })
    await expect(ctx.approval.request({ agent: await sessionAgent(ctx, 'normalized-extra'), toolName: 'bash', reason: 'de\u200blay\n tests' }))
      .resolves.toBe('rejected')
    await expect(ctx.settings.update(ApprovalAssessor.APPROVAL_ASSESSOR_SETTINGS_NAMESPACE, { extraPhrases: ['\u200b'] }))
      .rejects.toThrow('must contain text')
    await ctx.fiber.dispose()
  })
  it('rejects an approval request whose reason matches a work-avoidance pattern', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'evade-1')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this file since it is pre-existing code?',
    })

    expect(outcome).toBe('rejected')
  })

  it('rejects "out of scope" evasion', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'evade-2')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'grep',
      reason: 'This violation is out of scope for the current task.',
    })

    expect(outcome).toBe('rejected')
  })

  it('rejects "known limitation" evasion', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'evade-3')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'glob',
      reason: 'This is a known limitation of the framework.',
    })

    expect(outcome).toBe('rejected')
  })

  it('rejects "leave as-is" evasion', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'evade-4')

    const outcome = await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I leave this as-is since it already works?',
    })

    expect(outcome).toBe('rejected')
  })

  it('rejects a request without a justification', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'no-reason')
    // Missing justification cannot pass the mandatory audit.
    const outcome = await ctx.approval.request({ agent, toolName: 'read' })
    expect(outcome).toBe('rejected')
  })

  it('rejects a request with only whitespace as its justification', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'blank-reason')
    const outcome = await ctx.approval.request({ agent, toolName: 'read', reason: '   \n\t' })
    expect(outcome).toBe('rejected')
  })

  it('passes through when reason does not match any evasion pattern', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'legit-reason')
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
    const agent = await sessionAgent(ctx, 'bash-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'bash',
      reason: 'Should I skip this dangerous command?',
    })
    expect(outcome).toBe('rejected')
  })

  it('rejects write approval requests with work-avoidance justification', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'write-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'write',
      reason: 'This file is out of scope.',
    })
    expect(outcome).toBe('rejected')
  })

  it('rejects edit approval requests with work-avoidance justification', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'edit-gate')
    const outcome = await ctx.approval.request({
      agent,
      toolName: 'edit',
      reason: 'Known limitation, should I skip?',
    })
    expect(outcome).toBe('rejected')
  })
})

describe('user instruction quoting', () => {
  it('keeps an instruction at the excerpt bound complete', async () => {
    const ctx = await harness()
    const instruction = 'x'.repeat(500)
    const agent = await sessionAgent(ctx, 'exact-quote', [{ type: 'user/message', data: createUserMessage({
      content: [{ type: 'text', text: instruction }], source: { kind: 'user' },
    }) }])
    await ctx.approval.request({ agent, toolName: 'bash', reason: 'out of scope' })
    expect(redirects(agent).join('')).toContain(`User instruction: ${instruction}`)
    expect(redirects(agent).join('')).not.toContain('…')
  })

  it('uses the newest human text instruction when later content has no text block', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'non-text-quote', [
      { type: 'user/message', data: createUserMessage({ content: [{ type: 'text', text: 'Read the complete file.' }], source: { kind: 'user' } }) },
      { type: 'user/message', data: createUserMessage({ content: [{ type: 'reasoning', text: 'not a text instruction' }], source: { kind: 'user' } }) },
    ])
    await ctx.approval.request({ agent, toolName: 'bash', reason: 'out of scope' })
    expect(redirects(agent).join('')).toContain('User instruction: Read the complete file.')
    expect(redirects(agent).join('')).not.toContain('not a text instruction')
  })
  it('includes the last user instruction in the rejection context', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'quote-1')
    const session = agent.session
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Fix all lint violations in src/utils.ts' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await ctx.approval.request({
      agent,
      toolName: 'read',
      reason: 'Should I skip this pre-existing issue?',
    })

    expect(redirects(agent)).toHaveLength(1)
    const text = redirects(agent).join('')
    expect(text).toContain('Fix all lint violations in src/utils.ts')
    expect(text).toContain('Mandatory approval audit denied')
  })

  it('skips plugin snapshots that share the user role and quotes the human instruction', async () => {
    // A composed session interleaves runtime-context and reminder snapshots
    // with the human's messages; both are `user/message` rows. Quoting the
    // newest row would redirect the model to a plugin's own text.
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'quote-2')
    const session = agent.session
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Delete every dead export.' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Current runtime context. Approval policy: ask.' }],
      source: { kind: 'plugin', plugin: 'runtime-context', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })

    await ctx.approval.request({ agent, toolName: 'read', reason: 'Known limitation; leave it as-is.' })

    const text = redirects(agent).join('')
    expect(text).toContain('User instruction: Delete every dead export.')
    expect(text).not.toContain('Current runtime context')
  })

  it('ellipsizes an instruction longer than the excerpt bound', async () => {
    const ctx = await harness()
    const instruction = 'x'.repeat(640)
    const agent = await sessionAgent(ctx, 'quote-long')
    const session = agent.session
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: instruction }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    await ctx.approval.request({ agent, toolName: 'read', reason: 'This is out of scope.' })

    const text = redirects(agent).join('')
    expect(text).toContain(`User instruction: ${'x'.repeat(500)}\u2026`)
    expect(text).not.toContain('x'.repeat(501))
  })

  it('omits the quote when the session carries no human instruction', async () => {
    // A delegated subagent turn starts from a plugin-authored prompt.
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'quote-3')
    const session = agent.session
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'Delegated task body.' }],
      source: { kind: 'plugin', plugin: 'subagent', form: 'snapshot', sections: [] },
    }), { surfaceOp: 'append' })

    await ctx.approval.request({ agent, toolName: 'read', reason: 'This is out of scope.' })

    const text = redirects(agent).join('')
    expect(text).not.toContain('User instruction:')
  })
})

describe('downstream delegation', () => {
  it('cancels a withdrawn direct request before screening or delegation', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'cancelled')
    let downstream = 0
    ctx.on('approval/request', () => { downstream += 1; return Promise.resolve<ApprovalOutcome>('allowed-once') })
    await expect(ctx.waterfall(scopeTarget(agent, agent), 'approval/request', {
      agent, toolName: 'bash', reason: 'Run the build.', signal: AbortSignal.abort(),
    }, () => Promise.resolve<ApprovalOutcome>('unavailable'))).resolves.toBe('cancelled')
    expect(downstream).toBe(0)
    expect(agent.inbox.nextStep).toEqual([])
  })

  it('lets a downstream answerer decide when the request is not evasion', async () => {
    const ctx = await harness()
    const agent = await sessionAgent(ctx, 'delegate-1')
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
    const agent = await sessionAgent(ctx, 'no-delegate-1')
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
