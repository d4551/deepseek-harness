/**
 * The shared `continue: false`, `stopReason`, `systemMessage`, and
 * `stop_hook_active` fields as Claude Code applies them, driven through the
 * real loop, executor, and hook processes; only the model is scripted.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import { hookProgram } from '../../hook-protocol/tests/hook-program.ts'
import { dir, events, harness, hooks, MockAdapter, textResponse, toolCallResponse, waitForIdle } from './coverage-cases.ts'

const prompt = (text: string) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
const echo = () => defineContentToolFixture({ name: 'echo', description: 'e', parameters: {}, async execute() { return [{ type: 'text', text: 'ok' }] } })

describe('hooks-claude-code — continue:false', () => {
  it('UserPromptSubmit continue:false refuses the prompt, ends the turn on the hook cause, and shows the stop reason to the next request', async () => {
    const d = dir()
    const marker = join(d, 'halted-once')
    // Halts the first prompt only, so the follow-up turn shows what the model then sees.
    const s = hookProgram(d, 'halt', `if (exists(${JSON.stringify(marker)})) process.exit(0)\ntouch(${JSON.stringify(marker)})\nout('{"continue":false,"stopReason":"not now"}')\n`)
    const path = hooks(d, { UserPromptSubmit: [{ hooks: [{ type: 'command', command: s }] }] })
    const model = new MockAdapter([textResponse('later')])
    const ctx = await harness(path, model)
    const agent = ctx.agentLoop.create(SessionId('halt-prompt'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('first'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(0)
    expect(events(agent).findLast(e => e.type === 'turn/end')?.data).toEqual({ turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook', reason: 'not now' } } })
    agent.followup(prompt('second'))
    await waitForIdle(ctx, agent)
    const seen = JSON.stringify(model.requests.at(0)?.messages)
    expect(seen).toContain('not now')
    expect(seen.indexOf('not now')).toBeLessThan(seen.indexOf('second'))
  }, 15_000)

  it('PostToolUse continue:false has no effect on this point, as in Claude Code, and is warned about', async () => {
    const d = dir()
    const s = hookProgram(d, 'post', 'out(\'{"continue":false,"stopReason":"halt"}\')\n')
    const path = hooks(d, { PostToolUse: [{ hooks: [{ type: 'command', command: s }] }] })
    const model = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, model)
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.tools.register(echo())
    const agent = ctx.agentLoop.create(SessionId('post-stop'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(2)
    expect(events(agent).findLast(e => e.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PostToolUse hook returned continue: false'))
  })

  it('Stop continue:false outranks a blocking decision: the turn stops', async () => {
    const d = dir()
    const s = hookProgram(d, 'stop', 'out(\'{"decision":"block","reason":"keep going","continue":false}\')\n')
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const model = new MockAdapter([textResponse('done'), textResponse('never')])
    const ctx = await harness(path, model)
    const agent = ctx.agentLoop.create(SessionId('stop-halt'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(1)
    expect(events(agent).findLast(e => e.type === 'turn/end')?.data).toMatchObject({ reason: { kind: 'completed' } })
  })
})

describe('hooks-claude-code — systemMessage', () => {
  it('reaches the model as context on UserPromptSubmit and is warned about on PreToolUse', async () => {
    const d = dir()
    const onPrompt = hookProgram(d, 'prompt', 'out(\'{"systemMessage":"remember the budget"}\')\n')
    const onTool = hookProgram(d, 'tool', 'out(\'{"systemMessage":"unseen"}\')\n')
    const path = hooks(d, {
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: onPrompt }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: onTool }] }],
    })
    const model = new MockAdapter([toolCallResponse('c1', 'echo', {}), textResponse('done')])
    const ctx = await harness(path, model)
    const warn = vi.spyOn(ctx.logger, 'warn')
    ctx.tools.register(echo())
    const agent = ctx.agentLoop.create(SessionId('system-message'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    expect(JSON.stringify(model.requests.at(0)?.messages)).toContain('remember the budget')
    expect(JSON.stringify(model.requests.map(request => request.messages))).not.toContain('unseen')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('PreToolUse hook emitted a systemMessage'))
  })
})

describe('hooks-claude-code — Stop loop guard', () => {
  it('tells a Stop hook it already continued this turn through stop_hook_active', async () => {
    const d = dir()
    const payload = join(d, 'stop-payload')
    const marker = join(d, 'blocked-once')
    // Blocks the first run of the turn; the second run reads the flag and lets the turn stop.
    const s = hookProgram(d, 'stop', `capture(${JSON.stringify(payload)})\nif (exists(${JSON.stringify(marker)})) process.exit(0)\ntouch(${JSON.stringify(marker)})\nerr('once more')\nprocess.exit(2)\n`)
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const model = new MockAdapter([textResponse('first'), textResponse('second'), textResponse('never')])
    const ctx = await harness(path, model)
    const agent = ctx.agentLoop.create(SessionId('stop-flag'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(2)
    expect(JSON.stringify(model.requests.at(1)?.messages)).toContain('once more')
    expect(readFileSync(payload, 'utf8').replaceAll(/\s+/g, '')).toContain('"stop_hook_active":true')
  })

  it('overrides a Stop hook that blocks unconditionally after eight continuations', async () => {
    const d = dir()
    const s = hookProgram(d, 'stop', 'err(\'again\')\nprocess.exit(2)\n')
    const path = hooks(d, { Stop: [{ hooks: [{ type: 'command', command: s }] }] })
    const model = new MockAdapter(Array.from({ length: 10 }, (_, index) => textResponse(`step ${String(index)}`)))
    const ctx = await harness(path, model)
    const warn = vi.spyOn(ctx.logger, 'warn')
    const agent = ctx.agentLoop.create(SessionId('stop-cap'), { provider: 'mock', model: 'mock' })
    agent.followup(prompt('go'))
    await waitForIdle(ctx, agent)
    expect(model.requests).toHaveLength(9)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Stop hook blocked 8 consecutive times'))
  }, 30_000)
})
