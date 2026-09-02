/**
 * The Windows half of the credentials confidentiality check, against real
 * NTFS access-control lists. Windows has no permission bits, so the peer of
 * the POSIX `mode 644` refusal is a DACL that names another trustee; `icacls`
 * is the only way to produce one, which is why these cases are win32-only.
 *
 * They run in the `windows-native-tests` job, which is a dependency of the
 * pull-request verdict — a skip on every other host would otherwise mean the
 * Windows check is never executed anywhere.
 */

import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { LocalCredentialProvider } from '../src/index.ts'

const dirs: string[] = []

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** Run one `icacls` edit and fail loudly rather than testing an unchanged ACL. */
function icacls(...args: string[]): void {
  const result = spawnSync('icacls', args, { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(`icacls ${args.join(' ')} failed (${String(result.status)}): ${result.stdout}${result.stderr}`)
  }
}

/**
 * Write a credentials document whose DACL names its own owner and nobody else.
 * The owner SID comes from the descriptor the product reads, so the fixture
 * cannot drift from whichever account the runner created the file as.
 * @returns the document path and its owner SID.
 */
async function ownerOnlyDocument(): Promise<{ path: string; owner: string }> {
  const { FILE_READ_ACCESS, auditPathAccessWin32 } = await import('@deepseek-ai/dsh-win32-process/file-security')
  const dir = await mkdtemp(join(tmpdir(), 'dsh-credentials-acl-'))
  dirs.push(dir)
  const path = join(dir, '.credentials.yaml')
  await writeFile(path, 'version: 1\nrefs:\n  DSH_CRED_TEST: stored\n')
  const owner = auditPathAccessWin32(path, FILE_READ_ACCESS).owner
  expect(owner).toBeDefined()
  icacls(path, '/inheritance:r', '/grant:r', `*${owner ?? ''}:F`)
  return { path, owner: owner ?? '' }
}

describe.skipIf(process.platform !== 'win32')('credentials-local Windows confidentiality', () => {
  it('accepts a document whose DACL names only its owner', async () => {
    const { path } = await ownerOnlyDocument()

    const ctx = new Context()
    const fiber = ctx.plugin(LocalCredentialProvider, { path, watch: false })
    await fiber
    await fiber.dispose()
  })

  it('refuses a document another local account can read', async () => {
    const { path } = await ownerOnlyDocument()
    // S-1-5-11 is Authenticated Users: every account that logs on to this box.
    icacls(path, '/grant', '*S-1-5-11:(R)')

    const ctx = new Context()
    await expect(ctx.plugin(LocalCredentialProvider, { path, watch: false }))
      .rejects.toThrow(/grants access beyond its owner to .*S-1-5-11/)
  })
})
