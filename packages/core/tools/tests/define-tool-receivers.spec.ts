import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineTool } from '../src/index.ts'
import type {
  DefineToolOptions,
  ParameterSchemaSpec,
  ToolCallView,
  ToolExecution,
  ToolExecutionResult,
  ToolResult,
  ToolResultView,
  ValueSchemaSpec,
} from '../src/index.ts'

const parameters = { value: { type: 'string', required: true } } satisfies ParameterSchemaSpec
const outputSchema = { type: 'string' } satisfies ValueSchemaSpec
type Args = { value: string }

class Output {
  readonly schema = outputSchema
  #prefix = 'output'

  render(args: Args, value: string): ContentBlock[] {
    return [{ type: 'text', text: `${this.#prefix}:${args.value}:${value}` }]
  }

  presentationMeta(args: Args, value: string): string {
    return `${this.#prefix}:meta:${args.value}:${value}`
  }
}

class Options implements DefineToolOptions<typeof parameters, typeof outputSchema> {
  readonly name = 'receiver_tool'
  readonly description = 'Retain method receivers through typed tool definition.'
  readonly parameters = parameters
  readonly output = new Output()
  #prefix = 'options'

  execute(args: Args): Promise<string> {
    return Promise.resolve(`${this.#prefix}:${args.value}`)
  }

  finalizeContent(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): ContentBlock[] {
    return [...result.content, { type: 'text', text: `${this.#prefix}:final:${exec.name}` }]
  }

  presentCall(args: Args): ToolCallView {
    return { card: 'generic', title: `${this.#prefix}:call:${args.value}` }
  }

  presentResult(args: Args, result: ToolResult): ToolResultView {
    return { card: 'generic', title: `${this.#prefix}:result:${args.value}`, content: result.content }
  }

  isConcurrencySafe(args: Args): boolean {
    return args.value === this.#prefix
  }
}

describe('typed tool method receivers', () => {
  it('retains separate author and output receivers across execution and presentation', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime, {})
    const definition = defineTool(new Options())
    ctx.tools.register(definition)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('receiver-call'),
      name: definition.name,
      arguments: { value: 'input' },
    })

    expect(result).toMatchObject({
      isError: false,
      value: 'options:input',
      content: [
        { type: 'text', text: 'output:input:options:input' },
        { type: 'text', text: 'options:final:receiver_tool' },
      ],
      meta: 'output:meta:input:options:input',
    })
    expect(definition.presentCall?.({ value: 'input' })).toEqual({ card: 'generic', title: 'options:call:input' })
    expect(definition.presentResult?.({ value: 'input' }, result)).toEqual({
      card: 'generic', title: 'options:result:input', content: result.content,
    })
    expect(definition.isConcurrencySafe?.({ value: 'options' })).toBe(true)
    expect(definition.isConcurrencySafe?.({ value: 'input' })).toBe(false)
    await ctx.fiber.dispose()
  })
})
