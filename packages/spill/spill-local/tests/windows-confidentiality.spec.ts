/**
 * The Windows half of the spill-root trust checks, against real NTFS
 * access-control lists. Windows has no ownership or mode bits to inspect, so
 * the peer of the POSIX "owned by me and not group/other-writable" rule is a
 * DACL audit, and only `icacls` can produce the unsafe fixture.
 *
 * These cases are win32-only and run in the `windows-native-tests` job, which
 * is a dependency of the pull-request verdict.
 */

import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sweepSpillRoots } from '../src/cleanup.ts'

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

/** A spill root holding one stale session directory the sweep should reclaim. */
async function rootWithStaleSession(): Promise<{ root: string; chunk: string }> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-spill-acl-'))
  dirs.push(root)
  const session = join(root, `session-${'a'.repeat(12)}`)
  await mkdir(session)
  const chunk = join(session, 'chunk.bin')
  await writeFile(chunk, 'stale')
  return { root, chunk }
}

/** Everything already written is strictly older than this cutoff. */
function expireEverything(): number {
  return Date.now() + 60_000
}

describe.skipIf(process.platform !== 'win32')('spill-local Windows root trust', () => {
  it('sweeps a root whose DACL admits nobody but its owner', async () => {
    const { root, chunk } = await rootWithStaleSession()
    const warnings: string[] = []

    await sweepSpillRoots({
      roots: [{ path: root, pruneWhenEmpty: false }],
      cutoffMs: expireEverything(),
      warn: message => warnings.push(message),
    })

    expect(warnings).toEqual([])
    await expect(access(chunk)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses a root another local account can write into', async () => {
    const { root, chunk } = await rootWithStaleSession()
    // S-1-5-11 is Authenticated Users: another logged-on account could replace
    // the very files the sweep is about to walk.
    icacls(root, '/grant', '*S-1-5-11:(OI)(CI)(M)')
    const warnings: string[] = []

    await sweepSpillRoots({
      roots: [{ path: root, pruneWhenEmpty: false }],
      cutoffMs: expireEverything(),
      warn: message => warnings.push(message),
    })

    expect(warnings.join('\n')).toMatch(/skipped unsafe root/)
    // The unsafe root is left exactly as found.
    await expect(access(chunk)).resolves.toBeUndefined()
  })
})
