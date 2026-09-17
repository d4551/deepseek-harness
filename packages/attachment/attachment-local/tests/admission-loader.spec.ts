import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'

it('cancels admission through the real Loader and built attachment provider', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-admission-loader-'))
  try {
    const driver = fileURLToPath(new URL('./fixtures/admission-driver.mjs', import.meta.url))
    const config = fileURLToPath(new URL('./fixtures/admission.cordis.yml', import.meta.url))
    const result = await execa(process.execPath, [driver, config, home], { reject: false })
    expect(result.stderr).toBe('')
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toBe('Cancelled admission published nothing; subsequent admission and request are readable.')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
