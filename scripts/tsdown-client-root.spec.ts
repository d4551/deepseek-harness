/**
 * The tsdown client preset must find workspace manifests when unrun compiles
 * a package config into node_modules/.unrun, where a ../.. walk from
 * import.meta.url is not the repository root.
 */
import { mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  resolveRepositoryRoot,
  workspaceManifestAt,
} from './tsdown-workspace-root.ts'

const REPO = fileURLToPath(new URL('..', import.meta.url))

describe('resolveRepositoryRoot', () => {
  it('finds the workspace from cwd', () => {
    expect(realpathSync(resolveRepositoryRoot(REPO, REPO))).toBe(realpathSync(REPO))
  })

  it('finds the workspace from a package directory when cwd is elsewhere', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-tsdown-root-'))
    const fromPackage = join(REPO, 'packages', 'api', 'remotes')
    expect(realpathSync(resolveRepositoryRoot(elsewhere, fromPackage))).toBe(realpathSync(REPO))
  })

  it('finds the workspace from an unrun compile directory', () => {
    const unrunDir = join(REPO, 'node_modules', '.unrun')
    expect(realpathSync(resolveRepositoryRoot(unrunDir, unrunDir))).toBe(realpathSync(REPO))
  })

  it('rejects a tree that is not this workspace', () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-tsdown-empty-'))
    expect(() => resolveRepositoryRoot(elsewhere, elsewhere)).toThrow(/workspace root/)
  })

  it('proves a ../.. walk from a package tsdown.config.ts is not the repository root', () => {
    const compiled = pathToFileURL(join(REPO, 'packages', 'api', 'remotes', 'tsdown.config.ts')).href
    const relativeWalk = fileURLToPath(new URL('../..', compiled))
    expect(realpathSync(relativeWalk)).toBe(realpathSync(join(REPO, 'packages')))
    expect(realpathSync(relativeWalk)).not.toBe(realpathSync(REPO))
  })
})

describe('workspaceManifestAt', () => {
  it('reads @deepseek-ai/dsh-api-remotes from the workspace glob', () => {
    const manifest = workspaceManifestAt('@deepseek-ai/dsh-api-remotes', REPO)
    expect(manifest.name).toBe('@deepseek-ai/dsh-api-remotes')
  })

  it('throws when the glob root is a nested packages directory', () => {
    expect(() => workspaceManifestAt('@deepseek-ai/dsh-api-remotes', join(REPO, 'packages')))
      .toThrow(/no packages\/\*\/\*\/package\.json declares/)
  })

  it('throws when no package declares the name', () => {
    expect(() => workspaceManifestAt('@deepseek-ai/dsh-not-a-package', REPO))
      .toThrow(/no packages\/\*\/\*\/package\.json declares/)
  })
})
