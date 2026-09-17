import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'

const repository = resolve(import.meta.dirname, '..')
const cli = join(repository, 'node_modules/vitest/vitest.mjs')

interface BrowserSelection {
  readonly extraSource?: string
  readonly include?: readonly string[]
  readonly filters?: readonly string[]
  readonly api?: 'start' | 'create'
}

async function runBrowser(source: string, selection: BrowserSelection = {}): Promise<{ status: number | null; output: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-a11y-execution-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  await symlink(join(repository, 'node_modules'), join(root, 'node_modules'), 'dir')
  const owner = join(root, 'packages/client/ui-audit')
  await mkdir(join(owner, 'src'), { recursive: true })
  await mkdir(join(owner, 'tests'), { recursive: true })
  await symlink(join(repository, 'packages/client/ui-brand-official/node_modules'), join(owner, 'node_modules'), 'dir')
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }))
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify({
    extends: join(repository, 'tsconfig.base.json'), include: ['packages/**/*'],
  }))
  await writeFile(join(owner, 'src/Widget.tsx'), [
    "import { createElement } from 'react'",
    "export function Widget() { return createElement('button', null, 'Save') }",
  ].join('\n'))
  await writeFile(join(owner, 'tests/audit.client.spec.tsx'), source)
  if (selection.extraSource !== undefined) await writeFile(join(owner, 'tests/omitted.client.spec.tsx'), selection.extraSource)
  await writeFile(join(root, 'vitest.config.ts'), [
    "import { defineConfig } from 'vitest/config'",
    "import { playwright } from '@vitest/browser-playwright'",
    `import { standardDecoratorPlugin } from ${JSON.stringify(join(repository, 'vitest.shared.ts'))}`,
    'export default defineConfig({',
    `  root: ${JSON.stringify(root)}, cacheDir: ${JSON.stringify(join(root, '.cache/vite'))},`,
    '  resolve: { tsconfigPaths: true }, plugins: [standardDecoratorPlugin()],',
    `  server: { fs: { allow: ${JSON.stringify([root, repository])} } },`,
    '  test: {',
    `    include: ${JSON.stringify(selection.include ?? ['packages/*/*/tests/**/*.spec.tsx'])}, includeTaskLocation: true,`,
    `    setupFiles: [${JSON.stringify(join(repository, 'packages/test-support/client-a11y/tests/browser-setup.client.ts'))}],`,
    `    reporters: ['default', ${JSON.stringify(join(repository, 'scripts/client-a11y-reporter.ts'))}],`,
    "    browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] },",
    '  },',
    '})',
  ].join('\n'))
  let command = [cli, 'run', '--config', join(root, 'vitest.config.ts'), ...selection.filters ?? []]
  if (selection.api !== undefined) {
    const runner = join(root, 'run.mjs')
    const options = JSON.stringify({ config: join(root, 'vitest.config.ts'), run: true })
    const filters = JSON.stringify(selection.filters ?? [])
    await writeFile(runner, selection.api === 'start'
      ? `import { startVitest } from 'vitest/node'\nawait startVitest(${filters}, ${options})\n`
      : `import { createVitest } from 'vitest/node'\nconst runner = await createVitest(${options})\ntry { await runner.start(${filters}) } finally { await runner.close() }\n`)
    command = [runner]
  }
  const child = spawn(process.execPath, command, {
    cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const completion = new Promise<{ status: number | null; output: string }>((resolveRun, rejectRun) => {
    let output = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { output += chunk })
    child.once('error', rejectRun)
    child.once('close', (status) => { resolveRun({ status, output }) })
  })
  onTestFinished(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill()
    await completion
  })
  return completion
}

const imports = [
  "import { it, expect, afterEach } from 'vitest'",
  "import { createElement } from 'react'",
  "import { render, cleanup } from '@testing-library/react'",
  "import { accessibilityFailures, auditSurface } from '@deepseek-ai/dsh-client-a11y'",
  "import { Widget } from '../src/Widget.tsx'",
  'afterEach(cleanup)',
].join('\n')

const auditBody = [
  "const { baseElement } = render(createElement('main', null, createElement(Widget)))",
  "const audit = await auditSurface('Widget', baseElement)",
  "expect(accessibilityFailures([audit], 100)).toBe('')",
].join('\n')

it('accepts each native test only after its own real axe audit passes', async () => {
  const result = await runBrowser(`${imports}\nit.each(['first', 'second'])('native audit %s', async () => {\n${auditBody}\n})`)
  expect(result.output).toContain('Accessibility execution: 2 test(s) verified; complete package candidate inventory')
  expect(result.status, result.output).toBe(0)
})

it.each([
  ['unreachable body', `it('unreachable audit', async () => { if (false) {\n${auditBody}\n} })`],
  ['skipped definition', `it.skip('skipped audit', async () => {\n${auditBody}\n})`],
  ['unregistered definition', `if (false) it('unregistered audit', async () => {\n${auditBody}\n})`],
])('refuses a sibling receipt for an audit with %s', async (_label, declaration) => {
  const result = await runBrowser(`${imports}\nit('native sibling', async () => {\n${auditBody}\n})\n${declaration}`)
  expect(result.status, result.output).toBe(1)
  expect(result.output).not.toContain('Failed to import test file')
  expect(result.output).toMatch(/Tests\s+.*1 passed|Tests\s+.*2 passed/)
  expect(result.output).toContain('Accessibility execution evidence failed:')
  expect(result.output).toMatch(/has no passing native 100-point audit receipt|was not registered with a native location/)
})

it('refuses caller-created results even when their numbers claim a perfect score', async () => {
  const result = await runBrowser(`${imports}\nit('constructed result', () => {
    render(createElement('main', null, createElement(Widget)))
    const audit = { surface: 'constructed', violations: [], passed: 1, failed: 0, undecided: 0,
      undecidedRules: [], incomplete: [], completedReviews: [] }
    expect(accessibilityFailures([audit], 100)).toBe('')
    if (false) auditSurface('never executed', document.body)
  })`)
  expect(result.status, result.output).toBe(1)
  expect(result.output).not.toContain('Failed to import test file')
  expect(result.output).toMatch(/Tests\s+1 passed/)
  expect(result.output).toContain('constructed result has no passing native 100-point audit receipt')
})

it('distinguishes an unregistered audit from its native sibling on the same source line', async () => {
  const body = auditBody.replaceAll('\n', '; ')
  const result = await runBrowser(`${imports}\nit('native sibling', async () => { ${body} }); if (false) it('unregistered neighbor', async () => { ${body} })`)
  expect(result.status, result.output).toBe(1)
  expect(result.output).toMatch(/Tests\s+1 passed/)
  expect(result.output).toContain('was not registered with a native location')
})

it('refuses a native result borrowed from another test', async () => {
  const result = await runBrowser(`${imports}\nlet borrowed
    it('produces a result', async () => {
      const { baseElement } = render(createElement('main', null, createElement(Widget)))
      borrowed = await auditSurface('Widget', baseElement)
    })
    it('borrows the result', () => { expect(accessibilityFailures([borrowed], 100)).toBe('') })`)
  expect(result.status, result.output).toBe(1)
  expect(result.output).not.toContain('Failed to import test file')
  expect(result.output).toContain('Accessibility results must be produced and validated by the same test')
})

it('retains native axe failures when the returned audit is rewritten to claim success', async () => {
  const result = await runBrowser(`${imports}\nit('rewrites native failure', async () => {
    const { baseElement } = render(createElement('main', null, createElement(Widget), createElement('button')))
    const audit = await auditSurface('unnamed-control', baseElement)
    expect(audit.violations.some(result => result.id === 'button-name')).toBe(true)
    Object.assign(audit, { violations: [], passed: 1, failed: 0, undecided: 0,
      undecidedRules: [], incomplete: [], completedReviews: [] })
    expect(accessibilityFailures([audit], 100)).toBe('')
  })`)
  expect(result.status, result.output).toBe(1)
  expect(result.output).not.toContain('Failed to import test file')
  expect(result.output).toContain('button-name')
  expect(result.output).toContain('has no passing native 100-point audit receipt')
})

it.each<{ api: 'cli' | 'start' | 'create' }>([
  { api: 'cli' }, { api: 'start' }, { api: 'create' },
])('refuses a full $api run whose config omits an audit candidate', async ({ api }) => {
  const source = `${imports}\nit('native audit', async () => {\n${auditBody}\n})`
  const result = await runBrowser(source, {
    extraSource: source,
    include: ['packages/client/ui-audit/tests/audit.client.spec.tsx'],
    ...api === 'cli' ? {} : { api },
  })
  expect(result.status, result.output).toBe(1)
  expect(result.output).toContain('Required accessibility candidate is absent from configured discovery:')
  expect(result.output).toContain('omitted.client.spec.tsx')
})

it.each<{ api: 'cli' | 'start' | 'create' }>([
  { api: 'cli' }, { api: 'start' }, { api: 'create' },
])('labels an explicitly file-focused $api run as partial evidence', async ({ api }) => {
  const source = `${imports}\nit('native audit', async () => {\n${auditBody}\n})`
  const result = await runBrowser(source, {
    extraSource: source,
    filters: ['tests/audit.client.spec.tsx'],
    ...api === 'cli' ? {} : { api },
  })
  expect(result.status, result.output).toBe(0)
  expect(result.output).toContain('Accessibility execution: 1 test(s) verified; focused selection, not complete package evidence.')
})
