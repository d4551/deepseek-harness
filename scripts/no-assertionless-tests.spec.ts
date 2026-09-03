/**
 * Red/green contract plus the live-tree sweep for the assertionless-test gate.
 * Every finding kind proves it fires on an injected case, and every asserted
 * form proves it does not, before the clean-tree assertion counts for
 * anything.
 */

import { describe, expect, it } from 'vitest'
import {
  assertionlessTestCandidateFiles,
  auditAssertionlessTests,
  fixtureModuleResolver,
  scanAssertionlessTests,
  type AssertionlessTestFinding,
  type TestModuleSource,
} from './no-assertionless-tests.ts'

const SPEC = 'packages/a/b/tests/probe.spec.ts'

/** Line 1 of every fixture, so a finding's line is its authored line. */
const VITEST_IMPORT = "import { describe, expect, it, test } from 'vitest'"

/** Findings for one injected spec body, optionally over a fixture corpus. */
function findings(
  lines: readonly string[],
  modules: readonly TestModuleSource[] = [],
): AssertionlessTestFinding[] {
  const source = [VITEST_IMPORT, ...lines].join('\n')
  return scanAssertionlessTests(SPEC, source, fixtureModuleResolver(modules))
}

/** Finding kinds for one injected spec body, in source order. */
function kinds(lines: readonly string[], modules: readonly TestModuleSource[] = []): string[] {
  return findings(lines, modules).map(finding => finding.kind)
}

describe('injected cases', () => {
  it('reports a case that runs code and reaches no assertion', () => {
    expect(findings([
      "it('ignores status events for unknown sessions', () => {",
      "  manager.handleStatus('missing', true)",
      '})',
    ])).toEqual([{
      file: SPEC,
      line: 2,
      test: 'ignores status events for unknown sessions',
      kind: 'no-assertion',
      detail: 'the case reaches no assertion, so it passes whether or not the behavior its title names holds',
    }])
  })

  it('reports a case whose body runs no statements', () => {
    expect(findings(["it('is registered', () => {})"]).map(finding => ({
      kind: finding.kind,
      detail: finding.detail,
    }))).toEqual([{
      kind: 'empty-body',
      detail: 'the body runs no statements, so the runner records a pass for a case that tested nothing',
    }])
  })

  it('reports a body that holds only comments as empty', () => {
    expect(kinds([
      "it('is registered', () => {",
      '  // nothing to do yet',
      '})',
    ])).toEqual(['empty-body'])
  })

  it('reports a case whose only assertion sits in a listener callback', () => {
    expect(kinds([
      "it('publishes a change', () => {",
      "  bus.on('change', (value) => { expect(value).toBe(1) })",
      '  bus.publish(1)',
      '})',
    ])).toEqual(['callback-only-assertion'])
  })

  it('accepts a listener assertion when the case also asserts on its own', () => {
    expect(kinds([
      "it('publishes a change', () => {",
      '  const seen = []',
      "  bus.on('change', (value) => { expect(value).toBe(1) })",
      '  bus.publish(1)',
      '  expect(seen).toEqual([1])',
      '})',
    ])).toEqual([])
  })

  it('accepts every assertion vocabulary the runner ships', () => {
    expect(kinds(["it('a', () => { expect(1).toBe(1) })"])).toEqual([])
    expect(kinds(["it('b', () => { expect.soft(1).toBe(1) })"])).toEqual([])
    expect(kinds(["it('c', async () => { await expect(run()).rejects.toThrow() })"])).toEqual([])
    expect(kinds(["it('d', () => { assert.equal(1, 1) })"])).toEqual([])
    expect(kinds(["it('e', () => { expectTypeOf(v).toEqualTypeOf<number>() })"])).toEqual([])
    expect(kinds(["it('f', () => { assertType<number>(v) })"])).toEqual([])
  })

  it('accepts a case that delegates to a helper declared in the same module', () => {
    expect(kinds([
      "it('rejects an empty id', () => { rejectsEmptyId() })",
      'function rejectsEmptyId(): void { expect(() => parse(\'\')).toThrow() }',
    ])).toEqual([])
  })

  it('accepts a case that reaches its assertion three helpers deep', () => {
    expect(kinds([
      "it('rejects an empty id', () => { first() })",
      'function first(): void { second() }',
      'function second(): void { third() }',
      "function third(): void { expect(parse('')).toBeUndefined() }",
    ])).toEqual([])
  })

  it('reports a case whose assertion is deeper than the delegation budget', () => {
    expect(kinds([
      "it('rejects an empty id', () => { first() })",
      'function first(): void { second() }',
      'function second(): void { third() }',
      'function third(): void { fourth() }',
      "function fourth(): void { expect(parse('')).toBeUndefined() }",
    ])).toEqual(['no-assertion'])
  })

  it('accepts a case body imported over a relative path', () => {
    // The `type-model-cases-*` shape: the spec registers, the case module asserts.
    const cases: TestModuleSource = {
      file: 'packages/a/b/tests/cases.ts',
      source: [
        "import { expect } from 'vitest'",
        'export function buildsFaceModels(): void { expect(analyze().faces).toHaveLength(2) }',
        'export function silentCase(): void { analyze() }',
      ].join('\n'),
    }
    expect(kinds([
      "import { buildsFaceModels } from './cases.ts'",
      "it('builds independent face models', buildsFaceModels)",
    ], [cases])).toEqual([])
    expect(kinds([
      "import { silentCase } from './cases.ts'",
      "it('builds independent face models', silentCase)",
    ], [cases])).toEqual(['no-assertion'])
  })

  it('accepts a case that delegates through a renamed import', () => {
    const cases: TestModuleSource = {
      file: 'packages/a/b/tests/cases.ts',
      source: "import { expect } from 'vitest'\nexport function owned(): void { expect(1).toBe(1) }\n",
    }
    expect(kinds([
      "import { owned as registered } from './cases.ts'",
      "it('is owned', registered)",
    ], [cases])).toEqual([])
  })

  it('reports a case that delegates to a module outside the scanned corpus', () => {
    // A bare specifier is not resolvable here, so no assertion is proven.
    expect(kinds([
      "import { runCase } from '@deepseek-ai/dsh-test-harness'",
      "it('is owned elsewhere', runCase)",
    ])).toEqual(['no-assertion'])
  })

  it('accepts it.todo and the title-only registration, which have no body by design', () => {
    expect(kinds(["it.todo('restores focus after unmount')"])).toEqual([])
    expect(kinds(["it('restores focus after unmount')"])).toEqual([])
  })

  it('reads every vitest runner modifier chain as one case', () => {
    const silent = '() => { void 0 }'
    const chains = [
      `it.only('a', ${silent})`,
      `it.skip('b', ${silent})`,
      `it.fails('c', ${silent})`,
      `it.concurrent('d', ${silent})`,
      `it.sequential('e', ${silent})`,
      `it.concurrent.only('f', ${silent})`,
      `it.runIf(true)('g', ${silent})`,
      `it.skipIf(false)('h', ${silent})`,
      `it.each([1])('i %s', ${silent})`,
      `it.for([1])('j %s', ${silent})`,
      `it.extend({})('k', ${silent})`,
      `test('l', ${silent})`,
      `test.each([1])('m %s', ${silent})`,
    ]
    expect(kinds(chains)).toEqual(chains.map(() => 'no-assertion'))
  })

  it('counts the it.each table call and its registration as one case', () => {
    expect(findings([
      "it.each([1, 2])('handles %s', (value) => { void value })",
    ]).map(finding => finding.line)).toEqual([2])
  })

  it('does not read an unrelated member chain as a runner call', () => {
    // `test.ctx.on(...)` is a harness call: `on` is no runner modifier.
    expect(kinds(["test.ctx.on('goal/changed', () => { void 0 })"])).toEqual([])
    expect(kinds(["test.agent.session.events.filter((event) => event.type === 'x')"])).toEqual([])
  })

  it('does not read a local binding named test as the runner', () => {
    expect(kinds([
      'const test = bench()',
      "test('drives the harness', () => { void 0 })",
    ])).toEqual([])
  })

  it('reports a silent case nested in a describe block', () => {
    expect(findings([
      "describe('SessionManager', () => {",
      "  it('ignores unknown ids', () => { manager.handle('x') })",
      '})',
    ]).map(finding => finding.test)).toEqual(['ignores unknown ids'])
  })

  it('ignores a registration helper that builds its body from its parameters', () => {
    // `itInScratch(name, run)` registers a case whose assertions each caller
    // supplies, so the registration itself is not a case this module can judge.
    expect(kinds([
      'export function itInScratch(name: string, run: () => Promise<void>): void {',
      '  it(name, () => withScratch(run))',
      '}',
    ])).toEqual([])
  })

  it('accepts a throwing Testing Library query as the assertion it is', () => {
    // `findByText` rejects when the label never appears; `queryByText` answers
    // null and decides nothing.
    expect(kinds(["it('shows the provider', async () => { render(); await screen.findByText('DeepSeek') })"]))
      .toEqual([])
    expect(kinds(["it('shows the provider', () => { render(); view.getByRole('button') })"])).toEqual([])
    expect(kinds(["it('shows the provider', () => { render(); screen.queryByText('DeepSeek') })"]))
      .toEqual(['no-assertion'])
  })
})

describe('live tree', () => {
  const files = assertionlessTestCandidateFiles()

  it('scans a real corpus rather than an empty one', () => {
    expect(files.length).toBeGreaterThan(1000)
    expect(files.some(entry => entry.file.startsWith('packages/core/'))).toBe(true)
    expect(files.some(entry => entry.file === 'scripts/no-assertionless-tests.spec.ts')).toBe(true)
  })

  // A whole-corpus parse through one compiler session, plus the helper modules
  // the cases delegate to; the budget matches that cost, not the unit default.
  it('holds no test case that passes without exercising its behavior', { timeout: 120_000 }, () => {
    expect(auditAssertionlessTests()).toEqual([])
  })
})
