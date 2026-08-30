import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService, {
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import * as toolAskUser from '@deepseek-ai/dsh-tool-ask-user'

const testToolSignal = new AbortController().signal

interface QuestionAnswerer {
  ask(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer>
}

function registerQuestionAnswerer(ctx: Context, answerer: QuestionAnswerer): () => void {
  return ctx.on('user-questions/request', request => answerer.ask(request))
}

interface OptionSchemaShape {
  properties: {
    questions: {
      items: {
        properties: {
          options: {
            items: {
              properties: Record<string, { type: string }>
            }
          }
        } & Record<string, unknown>
      }
    }
  }
}

async function setup() {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(toolAskUser)
  return ctx
}

function stubAgent(id: string, delegationDepth = 0): Agent {
  const agentId = id as Agent['id']
  return {
    id: agentId,
    session: { id: agentId, header: { delegationDepth } },
  } as unknown as Agent
}

describe('ask_user_question tool', () => {
  it('registers a model-facing tool schema', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'ask_user_question')

    expect(schema).toMatchObject({
      name: 'ask_user_question',
      parameters: {
        type: 'object',
        properties: {
          questions: { type: 'array' },
        },
        required: ['questions'],
      },
    })
    const parameters = schema?.parameters as unknown as OptionSchemaShape
    expect(parameters.properties.questions.items.properties).toMatchObject({
      id: { type: 'string' },
      question: { type: 'string' },
      header: { type: 'string' },
      options: { type: 'array' },
      multi_select: { type: 'boolean' },
    })
    expect(parameters.properties.questions.items.properties.options.items.properties).toMatchObject({
      label: { type: 'string' },
      description: { type: 'string' },
    })
    expect(parameters.properties.questions.items.properties.options.items.properties).not.toHaveProperty('value')
    expect(parameters.properties.questions.items.properties.options.items.properties).not.toHaveProperty('recommended')
    expect(parameters.properties.questions.items.properties.options.items.properties).not.toHaveProperty('preview')
  })

  it('asks the registered user-questions provider and projects structured answers to text', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'pkg', selected: ['bun'] }] }
      },
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-1'),
      name: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'pkg',
          question: 'Which package manager should I use?',
          options: [{ label: 'bun', description: 'Use bun workspaces.' }],
        }],
      },
    })

    expect(result).toMatchObject({
      isError: false,
      content: [{ type: 'text', text: '{"answers":[{"id":"pkg","selected":["bun"]}]}' }],
    })
    expect(seen).toMatchObject([{
      questions: [{
        id: 'pkg',
        question: 'Which package manager should I use?',
        options: [{ label: 'bun', description: 'Use bun workspaces.' }],
      }],
    }])
  })

  it('passes recommended option labels through without adding schema fields', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'pkg', selected: ['bun (Recommended)'] }] }
      },
    })

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-recommended'),
      name: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'pkg',
          question: 'Which package manager should I use?',
          options: [
            { label: 'bun (Recommended)' },
            { label: 'npm' },
          ],
        }],
      },
    })

    expect(seen[0]?.questions[0]?.options).toEqual([
      { label: 'bun (Recommended)' },
      { label: 'npm' },
    ])
  })

  it('projects custom answers and multi-select choices', async () => {
    const ctx = await setup()
    registerQuestionAnswerer(ctx, {
      async ask() {
        return {
          answers: [
            { id: 'targets', selected: ['tests', 'docs'], custom: 'release notes' },
            { id: 'labels-only', selected: ['tests'] },
            { id: 'notes', selected: [], custom: 'ship today' },
          ],
        }
      },
    })

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-multi'),
      name: 'ask_user_question',
      arguments: {
        questions: [
          {
            id: 'targets',
            question: 'What should I update?',
            options: [{ label: 'tests' }, { label: 'docs' }],
            multi_select: true,
          },
          {
            id: 'labels-only',
            question: 'Which labels should I keep?',
            options: [{ label: 'tests' }, { label: 'docs' }],
            multi_select: true,
          },
          { id: 'notes', question: 'Any note?' },
        ],
      },
    })

    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected ask_user_question success')
    expect(result.value).toEqual({
      answers: [
        { id: 'targets', selected: ['tests', 'docs'], custom: 'release notes' },
        { id: 'labels-only', selected: ['tests'] },
        { id: 'notes', selected: [], custom: 'ship today' },
      ],
    })
    expect(result.content).toEqual([{
      type: 'text',
      text: '{"answers":[{"id":"targets","selected":["tests","docs"],"custom":"release notes"},{"id":"labels-only","selected":["tests"]},{"id":"notes","selected":[],"custom":"ship today"}]}',
    }])
  })

  it('passes the tool abort signal to the user-questions request', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'continue', selected: ['ok'] }] }
      },
    })
    const controller = new AbortController()

    await ctx.tools.execute({
      callId: ToolCallId('ask-2'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
      signal: controller.signal,
    })

    expect(seen[0]?.signal).toBe(controller.signal)
  })

  it('passes optional header and a resumed runtime root through to the user-questions request', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'continue', selected: ['ok'] }] }
      },
    })
    const agent = stubAgent('resumed-root', 1)
    ctx.agents.enter(agent, undefined)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-3'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', header: 'Confirm', question: 'Continue?' }] },
      agent,
    })

    expect(result.content).toEqual([{ type: 'text', text: '{"answers":[{"id":"continue","selected":["ok"]}]}' }])
    expect(seen[0]).toMatchObject({ questions: [{ id: 'continue', header: 'Confirm', question: 'Continue?' }], agent })
  })

  it('returns structured user-questions errors through tool execution', async () => {
    const ctx = await setup()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-no-provider'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'NO_PROVIDER' } },
    })
  })

  it('rejects a live runtime-owned agent with a structured DELEGATED_CALLER error', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'continue', selected: ['ok'] }] }
      },
    })
    const root = stubAgent('root', 0)
    const child = stubAgent('child', 0)
    ctx.agents.enter(root, undefined)
    ctx.agents.enter(child, root)

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-delegated'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'continue', question: 'Continue?' }] },
      agent: child,
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'DELEGATED_CALLER' } },
      content: [{
        type: 'text',
        text: "Error: human interaction is unavailable while the calling agent is owned by another live agent; include the unresolved question or decision in the child agent's final result",
      }],
    })
    expect(seen).toHaveLength(0)
  })

  it('returns a structured error for empty question batches', async () => {
    const ctx = await setup()

    const result = await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-empty'),
      name: 'ask_user_question',
      arguments: { questions: [] },
    })

    expect(result).toMatchObject({
      isError: true,
      error: { info: { name: 'UserQuestionError', code: 'EMPTY_QUESTIONS' } },
    })
  })

  it('unregisters the tool when its plugin fiber is disposed', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(UserQuestionService)
    const fiber = await ctx.plugin(toolAskUser)
    expect(ctx.tools.get('ask_user_question')).toBeDefined()

    await fiber.dispose()

    expect(ctx.tools.get('ask_user_question')).toBeUndefined()
  })
})

describe('ask_user_question model-facing surface', () => {
  /**
   * The description and every parameter description are what the model reads
   * to decide how to call this tool. Pinned verbatim: a fragment check leaves
   * the rest free to change, or empty, without a test noticing.
   */
  const DESCRIPTION =
    'Ask the user a concise question when you need confirmation, a choice, or missing information before proceeding. '
    + 'Send one or more questions, each with a stable id that will be echoed in the answer.'

  it('sends the whole tool description and every parameter description', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(entry => entry.name === 'ask_user_question')
    if (schema === undefined) throw new Error('ask_user_question is not registered')
    expect(schema.description).toBe(DESCRIPTION)

    const parameters = schema.parameters as {
      properties: {
        questions: {
          description: string
          items: {
            additionalProperties: boolean
            properties: Record<string, {
              description?: string
              additionalProperties?: boolean
              items?: { additionalProperties: boolean; properties: Record<string, { description?: string }> }
            }>
          }
        }
      }
    }
    const questions = parameters.properties.questions
    expect(questions.description).toBe('Questions to ask the user before continuing.')
    expect(questions.items.additionalProperties).toBe(true)

    const item = questions.items.properties
    expect(item.id?.description).toBe('Stable id for this question; echoed in the answer.')
    expect(item.question?.description).toBe('The specific question to ask the user.')
    expect(item.header?.description)
      .toBe('Optional short heading for the question, such as "Confirm" or "Choose Mode".')
    expect(item.options?.description)
      .toBe('Optional choices to show the user. If you recommend one, put it first and append "(Recommended)" to that label.')
    expect(item.multi_select?.description)
      .toBe('Whether the user may select more than one option. Defaults to false.')

    const option = item.options?.items
    expect(option?.additionalProperties).toBe(true)
    expect(option?.properties.label?.description).toBe('Short user-facing option label.')
    expect(option?.properties.description?.description).toBe('One sentence explaining the tradeoff or impact.')
  })

  it('forwards only the optional fields the model actually supplied', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'bare', selected: [] }] }
      },
    })

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-optional-absent'),
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'bare', question: 'Proceed?' }] },
    })

    // toEqual, not toMatchObject: forwarding `header: undefined` for a field
    // the model omitted is the defect this covers, and only an exact
    // comparison sees a key that should not be there.
    expect(seen[0]?.questions).toEqual([{ id: 'bare', question: 'Proceed?' }])
  })

  it('forwards every optional field when the model supplies them', async () => {
    const ctx = await setup()
    const seen: AskUserQuestionRequest[] = []
    registerQuestionAnswerer(ctx, {
      async ask(request) {
        seen.push(request)
        return { answers: [{ id: 'full', selected: ['a'] }] }
      },
    })

    await ctx.tools.execute({
      signal: testToolSignal,
      callId: ToolCallId('ask-optional-present'),
      name: 'ask_user_question',
      arguments: {
        questions: [{
          id: 'full',
          question: 'Which?',
          header: 'Choose',
          options: [{ label: 'a' }],
          multi_select: true,
        }],
      },
    })

    expect(seen[0]?.questions).toEqual([{
      id: 'full',
      question: 'Which?',
      header: 'Choose',
      options: [{ label: 'a' }],
      multiSelect: true,
    }])
  })
})
