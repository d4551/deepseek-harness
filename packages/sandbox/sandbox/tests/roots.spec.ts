/**
 * Tests for the writable-root derivation: the mode's meaning as a canonical
 * allow-list. Pinned here so the fs fence and the Seatbelt profile — both
 * deriving from `writableRoots` — cannot drift.
 */

import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { canonicalPath, workspaceRoots, writableRoots } from '@deepseek-ai/dsh-sandbox/roots'

const originalPlatform = process.platform

/** Run `body` as the given platform: the temp-area allow-list is platform-specific. */
function onPlatform<T>(platform: NodeJS.Platform, body: () => T): T {
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: platform })
  return body()
}

afterEach(() => {
  Reflect.defineProperty(process, 'platform', { configurable: true, enumerable: true, value: originalPlatform })
})

describe('canonicalPath', () => {
  it('resolves symlinks (an existing path realpaths)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-roots-'))
    expect(canonicalPath(dir)).toBe(realpathSync.native(dir))
  })

  it('returns the spelling as-is when the path cannot be resolved (conservative — matches nothing until it exists)', () => {
    expect(canonicalPath('/does/not/exist/anywhere-xyz')).toBe('/does/not/exist/anywhere-xyz')
  })
})

describe('writableRoots', () => {
  it('read-only grants nothing', () => {
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd() })).toEqual([])
  })

  it('workspace-write grants the workspace root plus the platform temp areas, canonical and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const roots = writableRoots({ mode: 'workspace-write', workspaceRoot: ws })
    expect(roots).toContain(realpathSync.native(ws))
    expect(roots).toContain(canonicalPath('/tmp'))
    expect(roots).toContain(realpathSync.native(tmpdir()))
    // Deduplicated after canonicalization (/tmp and os.tmpdir() may coincide).
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('workspace-write grants every additional workspace root, canonical, primary first, and deduplicated', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-ws-'))
    const extra = mkdtempSync(join(tmpdir(), 'dsh-extra-'))
    const roots = writableRoots({
      mode: 'workspace-write',
      workspaceRoot: ws,
      additionalWorkspaceRoots: [extra, extra, ws],
    })
    expect(roots[0]).toBe(realpathSync.native(ws))
    expect(roots).toContain(realpathSync.native(extra))
    expect(new Set(roots).size).toBe(roots.length)
  })

  it('read-only grants nothing even when the policy names additional roots', () => {
    const extra = mkdtempSync(join(tmpdir(), 'dsh-ro-extra-'))
    expect(writableRoots({ mode: 'read-only', workspaceRoot: process.cwd(), additionalWorkspaceRoots: [extra] })).toEqual([])
  })

  it('omits the POSIX system temp dir on Windows, where "/tmp" names no real temp area', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-win-'))
    const roots = onPlatform('win32', () => writableRoots({ mode: 'workspace-write', workspaceRoot: ws }))
    expect(roots).not.toContain(canonicalPath('/tmp'))
    expect(roots).toContain(realpathSync.native(tmpdir()))
    // The same policy on POSIX does grant it — the difference is the platform, not the policy.
    expect(onPlatform('linux', () => writableRoots({ mode: 'workspace-write', workspaceRoot: ws })))
      .toContain(canonicalPath('/tmp'))
  })
})

describe('workspaceRoots', () => {
  it('lists the policy\'s roots as specified, primary first, deduplicated, with no temp area', () => {
    const roots = workspaceRoots({
      mode: 'workspace-write',
      workspaceRoot: '/ws',
      additionalWorkspaceRoots: ['/second', '/ws'],
    })
    expect(roots).toEqual(['/ws', '/second'])
    expect(roots).not.toContain(realpathSync.native(tmpdir()))
  })

  it('does not re-resolve a root: the policy owner already did, and a dialect must grant what it was named', () => {
    const ws = mkdtempSync(join(tmpdir(), 'dsh-only-ws-'))
    expect(workspaceRoots({ mode: 'read-only', workspaceRoot: ws })).toEqual([ws])
  })
})
