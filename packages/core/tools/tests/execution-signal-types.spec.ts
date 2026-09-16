import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { analyzeTypescriptFile } from '../../../../scripts/typescript-semantics.ts'

const declarations = `
import { expectTypeOf } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {
  ToolDispatchExecution, ToolExecution, ToolExecutionInput, ToolRunContext,
} from '@deepseek-ai/dsh-tools'
export { expectTypeOf, ToolCallId, defineTool }
export type { ToolDispatchExecution, ToolExecution, ToolExecutionInput, ToolRunContext }
export declare const ctx: Context
export declare const input: ToolExecutionInput
export declare const execution: ToolExecution
export declare const run: ToolRunContext
`

const positiveConsumer = `
expectTypeOf<ToolExecutionInput['signal']>().toEqualTypeOf<AbortSignal>()
expectTypeOf<ToolExecution['signal']>().toEqualTypeOf<AbortSignal>()
expectTypeOf<ToolRunContext['signal']>().toEqualTypeOf<AbortSignal>()
expectTypeOf<ToolDispatchExecution['signal']>().toEqualTypeOf<AbortSignal>()
export const suppliedInput: ToolExecutionInput = {
  callId: ToolCallId('supplied'), name: 'probe', arguments: {}, signal: new AbortController().signal,
}
expectTypeOf(suppliedInput.signal).toEqualTypeOf<AbortSignal>()
ctx.on('tools/pre-execute', (exec, next) => {
  expectTypeOf(exec.signal).toEqualTypeOf<AbortSignal>()
  return next()
})
ctx.on('tools/post-execute', (exec, _result, next) => {
  expectTypeOf(exec.signal).toEqualTypeOf<AbortSignal>()
  return next()
})
ctx.on('tools/result', (exec) => {
  expectTypeOf(exec.signal).toEqualTypeOf<AbortSignal>()
})
ctx.on('tools/execute', (exec, next) => {
  expectTypeOf(exec.signal).toEqualTypeOf<AbortSignal>()
  exec.signal = new AbortController().signal
  return next()
})
export const inferredTool = defineTool({
  name: 'signal-inference',
  description: 'Pins contextual signal inference.',
  parameters: {},
  output: { schema: { type: 'null' }, render: () => [] },
  async execute(_args, exec) {
    expectTypeOf(exec.signal).toEqualTypeOf<AbortSignal>()
    return null
  },
})
expectTypeOf<typeof inferredTool.execute>().toBeFunction()
`

const directCases = [
  ['caller input requires a signal', [2741],
    "export const missingSignal: ToolExecutionInput = { callId: ToolCallId('missing'), name: 'probe', arguments: {} }"],
  ['caller input signal is readonly', [2540], 'input.signal = new AbortController().signal'],
  ['caller input signal cannot be deleted', [2704], 'delete input.signal'],
  ['caller input signal cannot become undefined', [2540], 'input.signal = undefined'],
  ['execution signal is readonly', [2540], 'execution.signal = new AbortController().signal'],
  ['execution signal cannot be deleted', [2704], 'delete execution.signal'],
  ['run context signal is readonly', [2540], 'run.signal = new AbortController().signal'],
  ['run context signal cannot be deleted', [2704], 'delete run.signal'],
  ['run context signal cannot become undefined', [2540], 'run.signal = undefined'],
] satisfies readonly (readonly [string, readonly number[], string])[]

const observerBindings = [
  ['tools/pre-execute', '(exec, next)', 'return next()'],
  ['tools/post-execute', '(exec, _result, next)', 'return next()'],
  ['tools/result', '(exec)', ''],
] satisfies readonly (readonly [string, string, string])[]

const observerMutations = [
  ['signal is readonly', [2540], 'exec.signal = new AbortController().signal'],
  ['signal cannot be deleted', [2704], 'delete exec.signal'],
  ['signal cannot become undefined', [2540], 'exec.signal = undefined'],
] satisfies readonly (readonly [string, readonly number[], string])[]

const dispatchMutations = [
  ['around-dispatch signal cannot be deleted', [2790], 'delete exec.signal'],
  ['around-dispatch signal cannot become undefined', [2322], 'exec.signal = undefined'],
] satisfies readonly (readonly [string, readonly number[], string])[]

const rejectedConsumers = [
  ...directCases.map(([obligation, codes, statement]) => ({ obligation, codes, statement, source: statement })),
  ...observerBindings.flatMap(([event, parameters, finish]) =>
    observerMutations.map(([obligation, codes, statement]) => ({
      obligation: `${event} ${obligation}`,
      codes,
      statement,
      source: `ctx.on('${event}', ${parameters} => {\n${statement}\n${finish}\n})`,
    }))),
  ...dispatchMutations.map(([obligation, codes, statement]) => ({
    obligation, codes, statement,
    source: `ctx.on('tools/execute', (exec, next) => {\n${statement}\nreturn next()\n})`,
  })),
  {
    obligation: 'defineTool infers a readonly execution signal',
    codes: [2540],
    statement: 'exec.signal = new AbortController().signal',
    source: `defineTool({
      name: 'signal-inference',
      description: 'Pins contextual signal inference.',
      parameters: {},
      output: { schema: { type: 'null' }, render: () => [] },
      async execute(_args, exec) {
        expectTypeOf(exec.signal).toEqualTypeOf<AbortSignal>()
        exec.signal = new AbortController().signal
        return null
      },
    })`,
  },
]

function checkConsumer(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-tool-signal-types-'))
  const repository = resolve(import.meta.dirname, '../../../..')
  try {
    symlinkSync(join(repository, 'node_modules'), join(directory, 'node_modules'), 'junction')
    const sourceFile = join(directory, 'consumer.ts')
    const configFile = join(directory, 'tsconfig.json')
    writeFileSync(configFile, JSON.stringify({
      extends: join(repository, 'tsconfig.base.json'),
      compilerOptions: { noEmit: true, composite: false, incremental: false },
      files: ['consumer.ts'],
    }))
    writeFileSync(sourceFile, `${declarations}\n${body}\n`)
    return { ...analyzeTypescriptFile(configFile, sourceFile), bodyStart: declarations.length + 1 }
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

describe('tool execution signal types', () => {
  it('compiles exact signals, inferred observers, and mutable around-dispatch signals', () => {
    expect(checkConsumer(positiveConsumer).diagnostics).toEqual([])
  })

  it.each(rejectedConsumers)('$obligation', ({ codes, statement, source }) => {
    const report = checkConsumer(source)
    expect(report.diagnostics.map(diagnostic => diagnostic.code)).toEqual(codes)
    expect(source.indexOf(statement)).toBeGreaterThanOrEqual(0)
    const start = report.bodyStart + source.indexOf(statement)
    for (const diagnostic of report.diagnostics) {
      expect(diagnostic).toMatchObject({ category: 1, fileName: report.file })
      expect(diagnostic.pos).toBeGreaterThanOrEqual(start)
      expect(diagnostic.end).toBeLessThanOrEqual(start + statement.length)
    }
  })
})
