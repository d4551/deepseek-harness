/**
 * The shared `continue: false`, `stopReason`, and `stop_hook_active` fields as
 * Codex applies them, driven through the real loop, executor, and hook
 * processes; only the model is scripted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { hookProgram } from '../../hook-protocol/tests/hook-program.ts'
import { dir, events, harness, hooks, MockAdapter, textResponse, toolCallResponse, waitForIdle } from './coverage-cases.ts'

const prompt = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const bash = () => defineContentToolFixture({ name: 'Bash', description: 'b', parameters: { command: { type: 'string' } }, async execute() { return [{ type: 'text', text: 'ok' }] } })

describe('hooks-codex — continue:false as Codex applies it', () => {
  it('PostToolUse continue:false replaces the tool result with the stop text and the turn continues', async () => {
    const d = dir()
    hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: hookProgram(d, 'post', 'out(\'{"continue":false,"stopReason":"use the other tool"}\')\n') }] }] })
    const model = new MockAdapter([toolCallResponse('c1', 'Bash', { command: 'x' }), textResponse('done')])
    const ctx = await harness(join(d, 'hooks.json'), model)
    ctx.tools.register(bash())
    const agent = ctx.agentLoop.create(SessionId('post-replace'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    const result = events(agent).find(e => e.type === 'tool/result')
    expect(result?.type === 'tool/result' && result.data.message.content[0].isError).toBe(true)
    expect(result?.type === 'tool/result' && result.data.message.content[0].content.some(b => b.type === 'text' && b.text.includes('use the other tool'))).toBe(true)
    expect(model.requests).toHaveLength(2)
    expect(events(agent).findLast(e => e.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
  })

  it('UserPromptSubmit continue:false refuses the prompt and records the stop reason without showing it to the model', async () => {
    const d = dir()
    const marker = join(d, 'halted-once')
    hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookProgram(d, 'halt', `if (exists(${JSON.stringify(marker)})) process.exit(0)\ntouch(${JSON.stringify(marker)})\nout('{"continue":false,"stopReason":"not now"}')\n`) }] }] })
    const model = new MockAdapter([textResponse('later')])
    const ctx = await harness(join(d, 'hooks.json'), model)
    const agent = ctx.agentLoop.create(SessionId('halt-prompt'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('first'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(0)
    expect(events(agent).findLast(e => e.type === 'turn/end')?.data).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'not now' } } })
    agent.followup(prompt('second'))
    await waitForIdle(ctx, agent)
    expect(JSON.stringify(model.requests.at(0)?.messages)).not.toContain('not now')
  }, 15_000)

  it('Stop continue:false outranks a blocking decision: the turn stops', async () => {
    const d = dir()
    hooks(d, { Stop: [{ hooks: [{ type: 'command', command: hookProgram(d, 'stop', 'out(\'{"decision":"block","reason":"keep going","continue":false}\')\n') }] }] })
    const model = new MockAdapter([textResponse('done'), textResponse('never')])
    const ctx = await harness(join(d, 'hooks.json'), model)
    const agent = ctx.agentLoop.create(SessionId('stop-halt'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(1)
    expect(events(agent).findLast(e => e.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
  })

  it('tells a Stop hook it already continued this turn through stop_hook_active', async () => {
    const d = dir()
    const payload = join(d, 'stop-payload')
    const marker = join(d, 'blocked-once')
    hooks(d, { Stop: [{ hooks: [{ type: 'command', command: hookProgram(d, 'stop', `capture(${JSON.stringify(payload)})\nif (exists(${JSON.stringify(marker)})) process.exit(0)\ntouch(${JSON.stringify(marker)})\nerr('once more')\nprocess.exit(2)\n`) }] }] })
    const model = new MockAdapter([textResponse('first'), textResponse('second'), textResponse('never')])
    const ctx = await harness(join(d, 'hooks.json'), model)
    const agent = ctx.agentLoop.create(SessionId('stop-flag'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(model.requests.at(1)?.messages)).toContain('once more')
    expect(readFileSync(payload, 'utf8').replaceAll(/\s+/g, '')).toContain('"stop_hook_active":true')
  })
})
