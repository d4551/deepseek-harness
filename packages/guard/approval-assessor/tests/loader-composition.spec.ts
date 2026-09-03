/**
 * Real Loader composition for the shipped mounting: the approval assessor sits
 * in front of the composed answerer chain, so a model that escalates with a
 * work-avoidance justification is denied and meets the user's instruction
 * again in the durable session log.
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
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import * as ApprovalAssessor from '../src/index.ts'
import * as Fixture from './fixtures/escalating-tool.ts'

const MODULES: Record<string, unknown> = {
  '@deepseek-ai/dsh-llm': LlmRuntime,
  '@deepseek-ai/dsh-session': SessionStore,
  '@deepseek-ai/dsh-system-prompt': SystemPrompt,
  '@deepseek-ai/dsh-tools': ToolRuntime,
  '@deepseek-ai/dsh-agent': AgentRegistry,
  '@deepseek-ai/dsh-agent-loop': AgentLoop,
  '@deepseek-ai/dsh-user-approval': ApprovalService,
  '@deepseek-ai/dsh-approval-assessor': ApprovalAssessor,
  'dsh-approval-assessor/tests/fixtures/escalating-tool': Fixture,
}

/** The composition under test, ordered as `dsh-base` orders it. */
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
  "- name: 'dsh-approval-assessor/tests/fixtures/escalating-tool'",
  '',
].join('\n')

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

/**
 * Boot the fixture composition through the real Loader.
 * @param entries - the Loader entry list to write and load.
 * @returns the booted context.
 */
async function boot(entries: string): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-approval-assessor-loader-'))
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
    sessionId: SessionId('assessor-composition'),
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

/** The plugin-attributed redirect texts in one session log, in log order. */
function redirects(events: readonly SessionEvent[]): string[] {
  return events.flatMap((event) => {
    if (event.type !== 'user/message') return []
    const message = event.data as { source?: { plugin?: string }; content?: { type: string; text?: string }[] }
    if (message.source?.plugin !== 'approval-assessor') return []
    return message.content?.flatMap(block => block.type === 'text' && block.text !== undefined ? [block.text] : []) ?? []
  })
}

describe('approval-assessor in a real Loader composition', () => {
  it('denies a work-avoidance escalation and logs the redirect beside the decision', async () => {
    context = await boot(CONFIG)

    const agent = await runTask(context, 'Fix every lint error in the report module.')
    const events = agent.session.events

    expect(events.filter(event => event.type === 'approval/asked')).toHaveLength(1)
    expect(events.flatMap(event => event.type === 'approval/decided' ? [event.data.outcome] : []))
      .toEqual(['rejected'])
    expect(redirects(events)).toEqual([
      'Mandatory approval audit denied "inspect_report": the justification is missing or '
      + 'indicates work-avoidance. Do not ask for permission to skip, defer, or soften work '
      + 'the user already instructed you to do. Refer to the user\'s original instructions and proceed.'
      + '\n\nUser instruction: Fix every lint error in the report module.',
    ])
  })
})
