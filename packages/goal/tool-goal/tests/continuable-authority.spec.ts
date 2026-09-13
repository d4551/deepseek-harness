import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import GoalService from '@deepseek-ai/dsh-goal'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentRuntime from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as toolGoal from '../src/index.ts'

/** Emit one prescribed model call, then finish subsequent model requests. */
class GoalMutationResponses extends LlmAdapter {
  call: ToolCallBlock | undefined

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    const call = this.call
    this.call = undefined
    if (call !== undefined) {
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: call }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Goal authority checked.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Compose the real goal and continuation services with durable child sessions. */
async function bootGoalDelegation() {
  const persistenceRoot = mkdtempSync(join(tmpdir(), 'dsh-goal-continuable-authority-'))
  const ctx = new Context()
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(persistenceRoot, { recursive: true, force: true })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(JsonlSessionPersistence, { root: persistenceRoot })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(GoalService)
  await ctx.plugin(SubagentRuntime)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(toolGoal, {})
  const responses = new GoalMutationResponses()
  ctx.llm.registerAdapter(['test'], responses)
  const parent = ctx.agentLoop.create(SessionId('goal-authority-parent'), { provider: 'test', model: 'test' })
  return { ctx, parent, responses }
}

it('preserves direct human root authority while continuation services are composed', async () => {
  const { ctx, parent, responses } = await bootGoalDelegation()
  responses.call = {
    type: 'tool-call',
    id: ToolCallId('root-goal-create'),
    name: 'create_goal',
    arguments: JSON.stringify({ objective: 'Human-owned root objective' }),
  }
  parent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Work until the root objective is complete' }],
    source: { kind: 'user' },
  }))
  await parent.whenIdle()

  expect(ctx.subagents.delegatingParent(parent)).toBeUndefined()
  const results = parent.session.events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  expect(results[0]?.data.error).toBeUndefined()
  expect(results[0]?.data.message.content[0].isError).toBe(false)
  expect(ctx.goals.get(parent)).toMatchObject({ objective: 'Human-owned root objective', phase: 'active' })
})

it.each(['create', 'edit', 'pause', 'resume', 'complete', 'blocked'])(
  'rejects %s from a manager-owned continuable child with synthetic user input',
  async (action) => {
    const { ctx, parent, responses } = await bootGoalDelegation()
    let childAtStartup: Agent | undefined
    let parentAtStartup: Agent | undefined
    let goalBefore: ReturnType<typeof ctx.goals.get>
    let structurallyRoot = false
    ctx.on('agent/session-start', ({ agent }) => {
      if (agent === parent) return
      childAtStartup = agent
      parentAtStartup = ctx.subagents.delegatingParent(agent)
      structurallyRoot = ctx.agents.roots().includes(agent)
      if (action !== 'create') {
        const goal = ctx.goals.create(agent, { objective: 'Host-owned child objective' })
        goalBefore = action === 'resume' ? ctx.goals.pause(agent, goal) : goal
      }
      responses.call = {
        type: 'tool-call',
        id: ToolCallId(`child-goal-${action}`),
        name: action === 'create' ? 'create_goal' : 'update_goal',
        arguments: JSON.stringify(action === 'create'
          ? { objective: 'Delegated creation must be denied' }
          : {
            goal_id: goalBefore?.id,
            revision: goalBefore?.revision,
            action,
            ...action === 'edit' ? { objective: 'Delegated edit must be denied' } : {},
            ...action === 'blocked' ? { blocked_reason: 'Delegated reporting must be denied' } : {},
          }),
      }
    })

    const started = await ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'Check delegated goal authority',
      request: { parent, prompt: [{ type: 'text', text: 'Attempt a goal mutation' }] },
      signal: new AbortController().signal,
    })
    const child = childAtStartup
    if (child === undefined) throw new Error('Expected the real continuable child at session startup')
    expect(child.id).toBe(started.childId)
    expect(structurallyRoot).toBe(true)
    expect(parentAtStartup).toBe(parent)
    await child.whenIdle()

    expect(child.session.events.some(event => event.type === 'user/message'
      && event.data.source.kind === 'user')).toBe(true)
    const results = child.session.events.filter(event => event.type === 'tool/result')
    expect(results).toHaveLength(1)
    expect(results[0]?.data.error?.code).toBe('GOAL_TOOL_AUTHORITY_REQUIRED')
    expect(results[0]?.data.message.content[0].isError).toBe(true)
    expect(ctx.goals.get(child)).toEqual(goalBefore)
    expect(ctx.goals.get(parent)).toBeUndefined()
  },
)
