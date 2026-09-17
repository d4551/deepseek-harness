import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { accessibilityTestDefinitions } from './client-a11y-candidates.ts'

it('retains skipped and unreachable audit callbacks as execution obligations', () => {
  const source = [
    "import { it as check } from 'vitest'",
    "import { accessibilityFailures as failures } from '@deepseek-ai/dsh-client-a11y'",
    "check.skip('skipped audit', () => { failures([], 100) })",
    "check('unreachable audit', () => { if (false) failures([], 100) })",
    "if (false) check('unregistered audit', () => { failures([], 100) })",
    "check('ordinary test', () => { Math.max(1, 2) })",
  ].join('\n')
  expect(accessibilityTestDefinitions('/native-a11y.spec.ts', source)).toEqual([
    { startLine: 3, startColumn: 1, endLine: 3, endColumn: 57 },
    { startLine: 4, startColumn: 1, endLine: 4, endColumn: 67 },
    { startLine: 5, startColumn: 12, endLine: 5, endColumn: 68 },
  ])
})

it('follows native test aliases, parameterization and local audit helper calls', () => {
  const source = [
    "import { test } from 'vitest'",
    "import { accessibilityFailures } from '@deepseek-ai/dsh-client-a11y'",
    'function assertAudit() { return accessibilityFailures([], 100) }',
    'const inspect = () => assertAudit()',
    "test.each(['first', 'second'])('audit %s', () => { inspect() })",
  ].join('\n')
  expect(accessibilityTestDefinitions('/native-a11y.spec.ts', source)).toEqual([
    { startLine: 5, startColumn: 1, endLine: 5, endColumn: 64 },
  ])
})

it('reads imported helper ownership afresh after its actual source changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'a11y-candidate-source-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const helper = join(root, 'audit.ts')
  const source = [
    "import { it } from 'vitest'",
    "import { inspect } from './audit.ts'",
    "it('audits through helper', () => { inspect() })",
  ].join('\n')
  await writeFile(helper, [
    "import { accessibilityFailures } from '@deepseek-ai/dsh-client-a11y'",
    'export function inspect() { return accessibilityFailures([], 100) }',
  ].join('\n'))
  expect(accessibilityTestDefinitions(join(root, 'audit.spec.ts'), source)).toEqual([
    { startLine: 3, startColumn: 1, endLine: 3, endColumn: 49 },
  ])
  await writeFile(helper, 'export function inspect() { return 42 }\n')
  expect(accessibilityTestDefinitions(join(root, 'audit.spec.ts'), source)).toEqual([])
})
