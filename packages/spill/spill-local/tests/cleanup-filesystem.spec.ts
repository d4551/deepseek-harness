import { spawnSync } from 'node:child_process'
import { chmod, chown, lstat, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { gatherSweepRoots, sweepSpillRoots } from '../src/cleanup.ts'
import { sessionDir } from '../src/store.ts'

let root: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-spill-filesystem-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('spill cleanup filesystem boundaries', () => {
  it('reports an invalid root path and still reclaims a separate valid root', async () => {
    const obstruction = join(root, 'file')
    await writeFile(obstruction, 'preserved')
    const valid = join(root, 'valid')
    const session = sessionDir(valid, 'session')
    await mkdir(session, { recursive: true, mode: 0o700 })
    await writeFile(join(session, 'expired'), 'old')
    const warnings: string[] = []
    const invalid = join(obstruction, 'child')

    await sweepSpillRoots({
      roots: [{ path: invalid, pruneWhenEmpty: true }, { path: valid, pruneWhenEmpty: true }],
      cutoffMs: Date.now() + 1,
      warn: (message) => { warnings.push(message) },
    })

    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain(`failed to inspect root ${invalid}`)
    expect(await readFile(obstruction, 'utf8')).toBe('preserved')
    await expect(lstat(valid)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('leaves a broken configured symlink intact and omits its absent target', async () => {
    const alias = join(root, 'configured')
    await symlink(join(root, 'missing'), alias, process.platform === 'win32' ? 'junction' : 'dir')
    const warnings: string[] = []

    expect(await gatherSweepRoots(alias, (message) => { warnings.push(message) }, root)).toEqual([])
    expect(warnings).toEqual([])
    expect((await lstat(alias)).isSymbolicLink()).toBe(true)
  })

  it('preserves nested directories, symlinks, unrelated siblings and exact-cutoff files', async () => {
    const session = sessionDir(root, 'kept')
    await mkdir(join(session, 'nested'), { recursive: true, mode: 0o700 })
    const nested = join(session, 'nested', 'content')
    const boundary = join(session, 'boundary')
    const unrelated = join(root, 'unrelated')
    await writeFile(nested, 'nested')
    await writeFile(boundary, 'boundary')
    await writeFile(unrelated, 'unrelated')
    await utimes(boundary, 1, 1)
    await symlink(join(session, 'nested'), join(session, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    const expired = sessionDir(root, 'expired')
    await mkdir(expired, { mode: 0o700 })
    await writeFile(join(expired, 'old'), 'old')
    await utimes(join(expired, 'old'), 0, 0)
    const warnings: string[] = []

    await sweepSpillRoots({
      roots: [{ path: root, pruneWhenEmpty: true }],
      cutoffMs: (await lstat(boundary)).mtimeMs,
      warn: (message) => { warnings.push(message) },
    })

    expect(warnings).toEqual([])
    expect(await readFile(nested, 'utf8')).toBe('nested')
    expect(await readFile(boundary, 'utf8')).toBe('boundary')
    expect(await readFile(unrelated, 'utf8')).toBe('unrelated')
    expect((await lstat(join(session, 'link'))).isSymbolicLink()).toBe(true)
    await expect(lstat(expired)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each(['root-read', 'session-read', 'delete'])('contains native %s denial and reclaims a neighboring session', async (operation) => {
    const deniedRoot = join(root, 'denied')
    const deniedSession = sessionDir(deniedRoot, 'denied')
    const deniedFile = join(deniedSession, 'expired')
    const goodRoot = join(root, 'good')
    const goodSession = sessionDir(goodRoot, 'good')
    await mkdir(deniedSession, { recursive: true, mode: 0o700 })
    await mkdir(goodSession, { recursive: true, mode: 0o700 })
    await writeFile(deniedFile, 'preserved')
    await writeFile(join(goodSession, 'expired'), 'removed')
    const denied = operation === 'root-read' ? deniedRoot : deniedSession
    const privileged = process.geteuid?.() === 0
    if (privileged) {
      for (const path of [root, deniedRoot, deniedSession, deniedFile, goodRoot, goodSession, join(goodSession, 'expired')]) {
        await chown(path, 65534, 65534)
      }
    }
    if (process.platform === 'win32') {
      const rights = operation === 'delete' ? '*S-1-1-0:(OI)(CI)(DE,DC)' : '*S-1-1-0:(RD)'
      const result = spawnSync('icacls', [denied, '/deny', rights], { encoding: 'utf8' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    } else {
      await chmod(denied, operation === 'delete' ? 0o500 : 0o100)
    }

    try {
      const source = pathToFileURL(join(import.meta.dirname, '../src/cleanup.ts')).href
      const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict'
        import { lstat, readFile, realpath } from 'node:fs/promises'
        import { sweepSpillRoots } from ${JSON.stringify(source)}
        if (process.geteuid?.() === 0) {
          process.setgid(65534)
          process.setuid(65534)
        }
        const [deniedRoot, goodRoot, deniedFile, goodSession, denied, operation] = process.argv.slice(1)
        const warnings = []
        await sweepSpillRoots({
          roots: [{ path: deniedRoot, pruneWhenEmpty: false }, { path: goodRoot, pruneWhenEmpty: false }],
          cutoffMs: Date.now() + 1,
          warn: message => { warnings.push(message) },
        })
        const expected = operation === 'root-read' ? 'failed to read root ' + await realpath(denied)
          : operation === 'session-read' ? 'failed to read ' + await realpath(denied)
            : 'failed to delete ' + await realpath(deniedFile)
        assert.equal(warnings.filter(message => message.includes(expected)).length, 1, JSON.stringify(warnings))
        assert.equal(warnings.length, 1)
        assert.equal(await readFile(deniedFile, 'utf8'), 'preserved')
        await assert.rejects(lstat(goodSession), { code: 'ENOENT' })
      `, deniedRoot, goodRoot, deniedFile, goodSession, denied, operation], { encoding: 'utf8' })
      expect(child.error).toBeUndefined()
      expect(child.signal).toBeNull()
      expect(child.status, child.stdout + child.stderr).toBe(0)
      expect(child.stderr).toBe('')
      expect(await readFile(deniedFile, 'utf8')).toBe('preserved')
      await expect(lstat(goodSession)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      if (process.platform === 'win32') {
        const result = spawnSync('icacls', [denied, '/remove:d', '*S-1-1-0'], { encoding: 'utf8' })
        expect(result.status, result.stdout + result.stderr).toBe(0)
      } else {
        await chmod(denied, 0o700)
      }
    }
  })
})
