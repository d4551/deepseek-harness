import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

const host = fileURLToPath(new URL('./fixtures/spill-failure-host.ts', import.meta.url))

it.each(['stdout', 'stderr'])('reports a %s spill failure without exiting the host', async (output) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-spill-failure-'))
  await rm(directory, { recursive: true })
  const result = await execa(process.execPath, ['--import', 'tsx', host, directory, output], {
    reject: false,
    timeout: 10_000,
  })
  expect(result.stderr).toBe('')
  expect(result.exitCode).toBe(0)
  expect(result.stdout).toContain('ENOENT')
})
