import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertLintScopeIntegrity, readLintScope } from './lint-scope-integrity.ts'
import { populateTestWorkspace } from './test-workspace-copy.ts'

const sourceRoot = fileURLToPath(new URL('..', import.meta.url))
let root: string
const oxlintCli = join(sourceRoot, 'node_modules/oxlint/bin/oxlint')
const suffix = randomUUID()
const probes = [
  ['packages/fs/fs-observation-policy/src', '.ts'],
  ['packages/fs/fs-observation-policy/tests', '.ts'],
  ['packages/client/ui-primitives/src', '.ts'],
  ['packages/client/ui-trajectory/tests', '.client.ts'],
  ['apps/cli/src', '.ts'],
  ['apps/cli/tests', '.ts'],
  ['apps/web/src', '.ts'],
  ['apps/web/tests', '.client.ts'],
  ['scripts', '.ts'],
  ['website', '.ts'],
  ['website/.vitepress', '.ts'],
].map(([directory, extension]) => {
  if (directory === undefined || extension === undefined) throw new Error('lint scope probe location is incomplete')
  return `${directory}/lint-scope-${suffix}${extension}`
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('expected lint report object')
  return value
}

function diagnostics(output: string): readonly unknown[] {
  const report = object(JSON.parse(output))
  if (!Array.isArray(report.diagnostics)) throw new Error('lint report has no diagnostics array')
  expect(report.number_of_files).toBeGreaterThan(probes.length)
  return report.diagnostics
}

describe('repository lint directory discovery', () => {
  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-lint-corpus-')))
    await populateTestWorkspace(sourceRoot, root)
    assertLintScopeIntegrity(readLintScope(root))
    await Promise.all(probes.map(path => writeFile(join(root, path), 'export const lintScopeValue = void 0\n', { flag: 'wx' })))
  }, 90_000)

  afterAll(async () => {
    if (root !== undefined) await rm(root, { recursive: true, force: true })
  })

  it('discovers every probe through the unchanged root configuration and exclusions', () => {
    const result = spawnSync(process.execPath, [oxlintCli, '.', '--format=json'], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      timeout: 90_000,
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(1)
    expect(result.stderr).toBe('')
    const findings = diagnostics(result.stdout)
    for (const path of probes) {
      const matching = findings.map(object).filter(finding => finding.filename === path && finding.code === 'eslint(no-void)')
      expect(matching, path).toHaveLength(1)
      expect(matching[0]).toMatchObject({ severity: 'error', labels: [{ span: { line: 1, column: 31 } }] })
    }
    assertLintScopeIntegrity(readLintScope(root))
  }, 100_000)
})
