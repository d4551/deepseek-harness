import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

it('installs every source-generated Stryker artifact with its owned dependency graph', async () => {
  const script = fileURLToPath(new URL('../tooling/stryker/verify-installed.mjs', import.meta.url))
  const result = await execa(process.execPath, [script])
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(JSON.parse(result.stdout)).toMatchObject({ verifiedFiles: 1006 })
})

it('executes complete call and argument mutation accounting through the installed instrumenter', async () => {
  const script = fileURLToPath(new URL('../tooling/stryker/runtime/mutation-accounting.test.mjs', import.meta.url))
  const result = await execa(process.execPath, ['--test', '--test-reporter=tap', script])
  expect(result.exitCode).toBe(0)
  expect(result.stderr).toBe('')
  expect(result.stdout).toContain('# tests 5')
  expect(result.stdout).toContain('# pass 5')
  expect(result.stdout).toContain('# fail 0')
  expect(result.stdout).toContain('# skipped 0')
})
