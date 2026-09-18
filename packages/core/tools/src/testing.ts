/** Canonical tool-definition fixtures for repository tests. @module dsh-tools/testing */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { isJsonValue, type JsonValue } from '@deepseek-ai/dsh-session'
import { defineTool } from './schema.ts'
import type { DefineToolOptions, ParameterSchemaSpec } from './schema.ts'
import type { ToolDefinition, ToolRunContext } from './index.ts'

const CONTENT_VALUE_SCHEMA = { type: 'array', items: { type: 'json' } } as const

function isJsonData(value: unknown): value is JsonValue {
  return isJsonValue(value)
}

function isContentBlock(value: object): value is ContentBlock {
  if (!('type' in value) || typeof value.type !== 'string') return false
  if (value.type === 'text' || value.type === 'reasoning') {
    return 'text' in value && typeof value.text === 'string'
  }
  if (value.type === 'image') {
    return 'attachment' in value && typeof value.attachment === 'object' && value.attachment !== null
  }
  if (value.type === 'tool-call') {
    return 'id' in value && 'name' in value && 'arguments' in value
  }
  if (value.type === 'tool-result') {
    return 'toolCallId' in value && 'content' in value && Array.isArray(value.content)
  }
  return false
}

/** Options for a fixture whose canonical value is its rendered content array. */
export type ContentToolFixtureOptions<S extends ParameterSchemaSpec> = Omit<
  DefineToolOptions<S, typeof CONTENT_VALUE_SCHEMA>,
  'output' | 'execute'
> & {
  /** Produce the fixture's content blocks as its canonical test value. */
  execute(args: import('./schema.ts').InferArgs<S>, exec: ToolRunContext): Promise<ContentBlock[]>
}

/**
 * Define a test fixture that deliberately uses its content blocks as the
 * canonical JSON value. Product tools must declare domain-owned DTOs instead.
 * @param options - ordinary fixture fields plus a content-producing body.
 * @returns a registry-ready tool with an explicit JSON-array output contract.
 * @internal
 */
export function defineContentToolFixture<const S extends ParameterSchemaSpec>(
  options: ContentToolFixtureOptions<S>,
): ToolDefinition {
  return defineTool({
    ...options,
    output: {
      schema: CONTENT_VALUE_SCHEMA,
      render: (_args, value) => {
        if (!Array.isArray(value)) throw new Error('content tool fixture: output is not an array')
        const blocks: ContentBlock[] = []
        for (const item of value) {
          if (item === null || typeof item !== 'object' || !isContentBlock(item)) {
            throw new Error('content tool fixture: output item is not a content block')
          }
          blocks.push(item)
        }
        return blocks
      },
    },
    async execute(args, exec) {
      const blocks = await options.execute(args, exec)
      const json: JsonValue[] = []
      for (const block of blocks) {
        const encoded: unknown = JSON.parse(JSON.stringify(block))
        if (!isJsonData(encoded)) throw new Error('content tool fixture: output is not JSON')
        json.push(encoded)
      }
      return json
    },
  })
}
