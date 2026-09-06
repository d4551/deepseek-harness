import { describe, expect, it } from 'vitest'
import {
  isNamedAliasException,
  isPluginDefaultConvention,
  parseKnipDuplicates,
  unexplainedDuplicateExports,
} from './knip-duplicate-exports.ts'

const WS_STUB = 'packages/experimental/webworker-runtime/src/node/external_packages/ws.ts'

function report(issues: unknown[]): string {
  return JSON.stringify({ issues })
}

describe('parseKnipDuplicates', () => {
  it('reads one row per duplicated binding, flattening the reporter groups', () => {
    expect(parseKnipDuplicates(report([
      {
        file: 'packages/core/tools/src/index.ts',
        duplicates: [[{ name: 'ToolRuntime', line: 788, col: 14, pos: 1 }, { name: 'default', line: 1945, col: 16, pos: 2 }]],
      },
      { file: 'packages/core/agent/src/index.ts', unlisted: [] },
    ]))).toEqual([{ file: 'packages/core/tools/src/index.ts', names: ['ToolRuntime', 'default'] }])
  })

  it('reads every group when one module duplicates two bindings', () => {
    expect(parseKnipDuplicates(report([{
      file: 'a.ts',
      duplicates: [
        [{ name: 'One' }, { name: 'default' }],
        [{ name: 'Two' }, { name: 'Alias' }],
      ],
    }]))).toEqual([
      { file: 'a.ts', names: ['One', 'default'] },
      { file: 'a.ts', names: ['Two', 'Alias'] },
    ])
  })

  it('rejects a report whose reporter stopped emitting the parts it reads', () => {
    expect(() => parseKnipDuplicates('[]')).toThrow(/no issues array/)
    expect(() => parseKnipDuplicates('null')).toThrow(/not an object/)
    expect(() => parseKnipDuplicates(report([null]))).toThrow(/issue is not an object/)
    expect(() => parseKnipDuplicates(report([{ duplicates: [] }]))).toThrow(/no file/)
    expect(() => parseKnipDuplicates(report([{ file: 'a.ts', duplicates: {} }]))).toThrow(/not an array/)
    expect(() => parseKnipDuplicates(report([{ file: 'a.ts', duplicates: [{}] }]))).toThrow(/group in a\.ts is not an array/)
    expect(() => parseKnipDuplicates(report([{ file: 'a.ts', duplicates: [[null]] }]))).toThrow(/duplicate in a\.ts is not an object/)
    expect(() => parseKnipDuplicates(report([{ file: 'a.ts', duplicates: [[{ line: 1 }]] }]))).toThrow(/has no name/)
  })
})

describe('duplicate export classification', () => {
  it('accepts the Cordis plugin convention and nothing wider', () => {
    expect(isPluginDefaultConvention(['ToolRuntime', 'default'])).toBe(true)
    expect(isPluginDefaultConvention(['default', 'ToolRuntime'])).toBe(true)
    expect(isPluginDefaultConvention(['ToolRuntime', 'Tools'])).toBe(false)
    expect(isPluginDefaultConvention(['ToolRuntime', 'Tools', 'default'])).toBe(false)
    expect(isPluginDefaultConvention(['default'])).toBe(false)
  })

  it('scopes a named alias exception to its own file and name set', () => {
    expect(isNamedAliasException(WS_STUB, ['WebSocketServer', 'Server'])).toBe(true)
    expect(isNamedAliasException(WS_STUB, ['Server', 'WebSocketServer'])).toBe(true)
    expect(isNamedAliasException(WS_STUB, ['WebSocketServer', 'Server', 'Sock'])).toBe(false)
    expect(isNamedAliasException('packages/other/src/ws.ts', ['WebSocketServer', 'Server'])).toBe(false)
  })

  it('reports a second name for one binding that is neither', () => {
    // The shape this gate exists to catch: an alias kept so existing imports
    // stay exact, which the pre-release stance rejects.
    expect(unexplainedDuplicateExports([
      { file: 'packages/core/tools/src/index.ts', names: ['ToolRuntime', 'default'] },
      { file: WS_STUB, names: ['WebSocketServer', 'Server'] },
      { file: 'packages/util/x/src/index.ts', names: ['MODULE_PARAMS', 'WRAPPER_PARAMS'] },
    ])).toEqual([{ file: 'packages/util/x/src/index.ts', names: ['MODULE_PARAMS', 'WRAPPER_PARAMS'] }])
  })

  it('passes a report with only conventional and declared duplicates', () => {
    expect(unexplainedDuplicateExports([
      { file: 'packages/core/tools/src/index.ts', names: ['ToolRuntime', 'default'] },
      { file: WS_STUB, names: ['Server', 'WebSocketServer'] },
    ])).toEqual([])
  })
})
