import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { COVERAGE_SOURCE_GLOB, coveragePolicyProblems, coverageSourceFiles, vitestConfigSource } from './coverage-debt.ts'

function config(coverage: string = '', thresholds: string = ''): string {
  return `export default { test: { coverage: {
    provider: 'v8', reportOnFailure: true, autoAttachSubprocess: true,
    include: ['${COVERAGE_SOURCE_GLOB}'],
    thresholds: { perFile: true, statements: 100, branches: 100, functions: 100, lines: 100 ${thresholds} }
    ${coverage}
  } } }`
}

async function sourceTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-coverage-policy-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'packages/a/b/src/nested'), { recursive: true })
  return root
}

describe('coverage source discovery', () => {
  it('includes all source extensions, declarations, entrypoints and file links', async () => {
    const root = await sourceTree()
    const names = ['x.ts', 'x.tsx', 'x.js', 'x.jsx', 'x.mts', 'x.cts', 'x.mjs', 'x.cjs', 'types.d.ts', 'bin.ts', 'worker.ts', 'nested/z.ts']
    for (const name of names) await writeFile(join(root, 'packages/a/b/src', name), 'export const value = 1\n')
    await writeFile(join(root, 'packages/a/b/src/asset.css'), 'body {}\n')
    await symlink(join(root, 'packages/a/b/src/x.ts'), join(root, 'packages/a/b/src/linked.ts'), 'file')
    expect(coverageSourceFiles(root)).toEqual([...names, 'linked.ts'].map(name => `packages/a/b/src/${name}`).sort())
  })

  it('rejects an empty corpus', async () => {
    const root = await sourceTree()
    expect(() => coverageSourceFiles(root)).toThrow('no package source files')
  })
})

describe('coverage policy', () => {
  it('validates the live configuration and discovers its sources', () => {
    expect(coveragePolicyProblems(vitestConfigSource())).toEqual([])
    expect(coverageSourceFiles().length).toBeGreaterThan(0)
  })

  it('accepts literal policy with absent or empty exclusions', () => {
    expect(coveragePolicyProblems(config())).toEqual([])
    expect(coveragePolicyProblems(config(', exclude: []'))).toEqual([])
  })

  it('reads named imports and quoted properties without matching comments or string contents', () => {
    const source = config().replace(`'${COVERAGE_SOURCE_GLOB}'`, 'sourcePattern').replace('coverage:', '"coverage":')
    expect(coveragePolicyProblems(`
      import { COVERAGE_SOURCE_GLOB as sourcePattern } from './scripts/coverage-debt.ts'
      import { defineConfig } from 'vitest/config'
      const text = 'coverage: { exclude: ["hidden"] }'
      // coverage: { exclude: ['hidden'] }
      ${source.replace('export default {', 'export default defineConfig({')})
    `)).toEqual([])
  })

  it.each(["['packages/a/b/src/x.ts']", '[...platformFiles]', 'exclusions', 'enabled ? [] : ["x"]'])('rejects exclusions %s', (value) => {
    expect(coveragePolicyProblems(config(`, exclude: ${value}`))).toContain('coverage.exclude must be absent or an empty literal array')
  })

  it.each(["['packages/a/b/src/**/*.ts']", '[]', '[sourcePattern]', "['!packages/a/b/src/x.ts']"])('rejects narrowed source selection %s', (value) => {
    const source = config().replace(`['${COVERAGE_SOURCE_GLOB}']`, value)
    expect(coveragePolicyProblems(source)).toContain(`coverage.include must contain exactly ${COVERAGE_SOURCE_GLOB}`)
  })

  it.each(['perFile: false', 'statements: 99', 'branches: 0', 'functions: -1', 'lines: minimum'])('rejects weakened metric %s', (replacement) => {
    const key = replacement.split(':')[0]
    const source = config().replace(new RegExp(`${key}: (true|100)`), replacement)
    expect(coveragePolicyProblems(source)).toHaveLength(1)
  })

  it('rejects threshold groups and automatic updates', () => {
    expect(coveragePolicyProblems(config('', ", 'packages/**': { lines: 0 }, autoUpdate: true"))).toHaveLength(2)
  })

  it.each(['false', 'enabled'])('rejects disabling or conditionally enabling coverage with %s', (value) => {
    expect(coveragePolicyProblems(config(`, enabled: ${value}`))).toContain('coverage.enabled must be absent or true')
  })

  it.each(["['constructor']", '[...methods]', 'methods'])('rejects omitted class methods %s', (value) => {
    expect(coveragePolicyProblems(config(`, ignoreClassMethods: ${value}`)))
      .toContain('coverage.ignoreClassMethods must be absent or an empty literal array')
  })

  it.each(['true', "'main'", 'changed'])('rejects changed-file coverage %s', (value) => {
    expect(coveragePolicyProblems(config(`, changed: ${value}`))).toContain('coverage.changed must be absent or false')
    const source = config(', changed: false').replace('test: {', `test: { changed: ${value},`)
    expect(coveragePolicyProblems(source)).toContain('test.changed must be absent or false')
  })

  it('requires fresh measurements on reruns and subprocess collection', () => {
    expect(coveragePolicyProblems(config(', cleanOnRerun: false'))).toContain('coverage.cleanOnRerun must be absent or true')
    expect(coveragePolicyProblems(config().replace('autoAttachSubprocess: true', 'autoAttachSubprocess: false')))
      .toContain('coverage.autoAttachSubprocess must be true')
    expect(coveragePolicyProblems(config().replace(', autoAttachSubprocess: true', '')))
      .toContain('coverage.autoAttachSubprocess must be true')
  })

  it('accepts explicit complete-measurement settings and presentation options', () => {
    expect(coveragePolicyProblems(config(`,
      enabled: true, changed: false, cleanOnRerun: true, ignoreClassMethods: [],
      processingConcurrency: 2, watermarks: { lines: [80, 95] }, skipFull: true
    `))).toEqual([])
  })

  it('accepts a renamed defineConfig value import from Vitest', () => {
    const source = config().replace('export default {', 'export default configure({')
    expect(coveragePolicyProblems(`import { defineConfig as configure } from 'vitest/config'\n${source})`)).toEqual([])
  })

  it.each([
    "import { defineConfig } from './other-config.ts'",
    'function defineConfig(value) { value.test.coverage.include = []; return value }',
    "import type { defineConfig } from 'vitest/config'",
    "import { type defineConfig } from 'vitest/config'",
    '',
  ])('rejects an unverified config factory %s', (declaration) => {
    const source = config().replace('export default {', 'export default defineConfig({')
    expect(() => coveragePolicyProblems(`${declaration}\n${source})`)).toThrow('defineConfig value import from vitest/config')
  })

  it.each([
    'export default {}',
    config().replace('coverage: {', 'coverage: { ...extra,'),
    config().replace('coverage: {', 'coverage: { [key]: [],'),
    config().replace('coverage: {', 'coverage: { get exclude() { return [] },'),
    config().replace('perFile: true', 'perFile: true, perFile: false'),
    config().replace('thresholds: {', 'thresholds: enabled ? undefined : {'),
    config().replace('coverage: {', 'coverage: extra || {'),
  ])('rejects unreadable or ambiguous policy', (source) => {
    expect(() => coveragePolicyProblems(source)).toThrow()
  })

  it('rejects absent exports, disabled failure reporting and another provider', () => {
    expect(() => coveragePolicyProblems('const configuration = {}')).toThrow('requires a default export')
    expect(coveragePolicyProblems(config().replace("provider: 'v8'", "provider: 'custom'"))).toContain('coverage.provider must be v8')
    expect(coveragePolicyProblems(config().replace('reportOnFailure: true', 'reportOnFailure: false'))).toContain('coverage.reportOnFailure must be true')
  })
})
