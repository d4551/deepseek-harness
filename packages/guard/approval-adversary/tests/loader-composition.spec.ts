/**
 * Real Loader composition for the shipped mounting: the adversary sits behind
 * the assessor's screen and ahead of the composed answerer chain, so an
 * enabled deployment decides an escalation with a model review, logs that
 * review, and hands the verdict to the model as a notice the next request
 * carries.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as ApprovalAssessor from '@deepseek-ai/dsh-approval-assessor'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as ApprovalAdversary from '../src/index.ts'
import * as Fixture from './fixtures/reviewed-tool.ts'

const MODULES: Record<string, unknown> = {
  '@deepseek-ai/dsh-llm': LlmRuntime,
  '@deepseek-ai/dsh-session': SessionStore,
  '@deepseek-ai/dsh-system-prompt': SystemPrompt,
  '@deepseek-ai/dsh-tools': ToolRuntime,
  '@deepseek-ai/dsh-agent': AgentRegistry,
  '@deepseek-ai/dsh-agent-loop': AgentLoop,
  '@deepseek-ai/dsh-user-approval': ApprovalService,
  '@deepseek-ai/dsh-approval-assessor': ApprovalAssessor,
  '@deepseek-ai/dsh-approval-adversary': ApprovalAdversary,
  'dsh-approval-adversary/tests/fixtures/reviewed-tool': Fixture,
}

/** The composition under test, ordered as `dsh-base` orders it, with the adversary enabled. */
const CONFIG = [
  "- name: '@deepseek-ai/dsh-llm'",
  "- name: '@deepseek-ai/dsh-session'",
  "- name: '@deepseek-ai/dsh-system-prompt'",
  "- name: '@deepseek-ai/dsh-tools'",
  "- name: '@deepseek-ai/dsh-agent'",
  "- name: '@deepseek-ai/dsh-agent-loop'",
  '  config:',
  '    agents: []',
  "- name: '@deepseek-ai/dsh-user-approval'",
  '  config:',
  '    policy: ask',
  "- name: '@deepseek-ai/dsh-approval-assessor'",
  "- name: '@deepseek-ai/dsh-approval-adversary'",
  '  config:',
  '    enabled: true',
  '    fallback: delegate',
  '    timeoutMs: 30000',
  '    maxOutputTokens: 256',
  '    maxExcerptChars: 4000',
  "- name: 'dsh-approval-adversary/tests/fixtures/reviewed-tool'",
  '',
].join('\n')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  Fixture.requests.length = 0
})

/**
 * Boot the fixture composition through the real Loader.
 * @param entries - the Loader entry list to write and load.
 * @returns the booted context.
 */
async function boot(entries: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-approval-adversary-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, entries)
  const ctx = new Context()
  ctx.baseUrl = `${pathToFileURL(root).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = {
    version: 'v2',
    import(specifier: string) {
      const module = MODULES[specifier]
      if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
      return Promise.resolve(module)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/**
 * Drive one task through a fresh agent of the booted composition.
 * @param ctx - the booted composition.
 * @param task - the user instruction to send.
 * @returns the agent after its driver settles.
 */
async function runTask(ctx: Context, task: string): Promise<Agent> {
  const handle = await ctx.agents.create({
    sessionId: SessionId('adversary-composition'),
    agentOptions: { provider: 'mock', model: 'mock-model' },
  })
  const agent = handle.agent
  const idle = new Promise<void>((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject !== agent || status !== 'idle') return
      dispose()
      resolve()
    })
  })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: task }], source: { kind: 'user' } }))
  await idle
  return agent
}

/** The plugin-attributed notices in one session log, in log order, with their sequence positions. */
function adversaryNotices(events: readonly SessionEvent[]): { seq: number; summary: string; text: string }[] {
  return events.flatMap((event) => {
    if (event.type !== 'user/message') return []
    const message = event.data as UserMessage & { source: { plugin?: string; summary?: string } }
    if (message.source.plugin !== 'approval-adversary') return []
    return [{
      seq: event.seq,
      summary: message.source.summary ?? '',
      text: message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join(''),
    }]
  })
}

/** The tool result text the model received for the fixture call. */
function toolResultText(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'tool/result') return []
    const [block] = event.data.message.content
    return block.content.flatMap(inner => inner.type === 'text' ? [inner.text] : [])
  })
}

describe('approval-adversary in a real Loader composition', () => {
  it('allows a justified escalation, logs the review, and carries the verdict into the next request', async () => {
    Fixture.scenario.justification = 'the user asked to remove stale build output before rebuilding'
    Fixture.scenario.review = 'VERDICT: ALLOW\nREASON: removing stale output is the step the user asked for'
    context = await boot(CONFIG)

    const agent = await runTask(context, 'Remove the stale build output and rebuild.')
    const events = agent.session.events

    const asked = events.filter(event => event.type === 'approval/asked')
    expect(asked).toHaveLength(1)
    const decided = events.filter(event => event.type === 'approval/decided')
    expect(decided.map(event => event.data.outcome)).toEqual(['allowed-once'])
    expect(toolResultText(events)).toEqual(['outcome:allowed-once'])

    // The review is logged before dispatch, paired with the audit id, on the
    // agent's own route because the composition names none.
    const review = events.filter(event => event.type === 'approval/adversary-request')
    expect(review).toHaveLength(1)
    expect(review[0]!.data).toMatchObject({
      approvalId: asked[0]!.data.id,
      toolName: Fixture.FIXTURE_TOOL,
      route: { provider: 'mock', model: 'mock-model' },
      system: ApprovalAdversary.REVIEW_INSTRUCTIONS,
      maxTokens: 256,
    })
    expect(review[0]!.seq).toBeGreaterThan(asked[0]!.seq)
    expect(review[0]!.seq).toBeLessThan(decided[0]!.seq)

    // The reviewer saw the user's instruction, the exact call, and the justification.
    const reviewerCalls = Fixture.requests.filter(request => request.tools === undefined)
    expect(reviewerCalls).toHaveLength(1)
    const record = reviewerCalls[0]!.messages[0]!.content
      .flatMap(block => block.type === 'text' ? [block.text] : []).join('')
    expect(record).toContain('"instruction":"Remove the stale build output and rebuild."')
    expect(record).toContain(`"call":{"name":"${Fixture.FIXTURE_TOOL}","arguments":"{\\"justification\\":\\"the user asked to remove stale build output before rebuilding\\"}"}`)
    expect(record).toContain('"justification":"escalate sandbox to danger-full-access: the user asked to remove stale build output before rebuilding"')

    // The notice reaches the log through the inbox after the decision, and
    // the closing model request carries it.
    const notices = adversaryNotices(events)
    expect(notices.map(({ summary, text }) => ({ summary, text }))).toEqual([{
      summary: 'adversarial review: allowed',
      text: `Adversarial approval review allowed "${Fixture.FIXTURE_TOOL}": removing stale output is the step the user asked for`,
    }])
    expect(notices[0]!.seq).toBeGreaterThan(decided[0]!.seq)
    const agentTurns = Fixture.requests.filter(request => request.tools !== undefined)
    expect(agentTurns).toHaveLength(2)
    const closingTexts = agentTurns[1]!.messages
      .flatMap(message => message.content.flatMap(block => block.type === 'text' ? [block.text] : []))
    expect(closingTexts).toContain(notices[0]!.text)
  })

  it('denies an overreaching escalation the assessor let through and quotes the instruction', async () => {
    Fixture.scenario.justification = 'disable the failing tests so the suite passes'
    Fixture.scenario.review = 'VERDICT: DENY\nREASON: disabling tests hides failures instead of fixing them'
    context = await boot(CONFIG)

    const agent = await runTask(context, 'Fix every failing test in the suite.')
    const events = agent.session.events

    expect(events.flatMap(event => event.type === 'approval/decided' ? [event.data.outcome] : []))
      .toEqual(['rejected'])
    expect(toolResultText(events)).toEqual(['outcome:rejected'])
    // The assessor's screen passed this justification; only the review denied it.
    expect(events.some(event => event.type === 'user/message'
      && (event.data as UserMessage & { source: { plugin?: string } }).source.plugin === 'approval-assessor')).toBe(false)
    expect(adversaryNotices(events).map(notice => notice.text)).toEqual([
      `Adversarial approval review denied "${Fixture.FIXTURE_TOOL}": disabling tests hides failures instead of fixing them\n`
      + 'Do not resubmit the same request with a reworded justification. '
      + 'Return to the user\'s instructions and take the direct step they asked for.'
      + '\n\nUser instruction: Fix every failing test in the suite.',
    ])
  })
})
