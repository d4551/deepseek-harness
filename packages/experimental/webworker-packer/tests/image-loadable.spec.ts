/**
 * Unit plane of the packer's repository knowledge: workspace indexing,
 * config-tree declarations, preview fixtures, and pack reporting. Everything
 * here reads source-tree facts and needs no built output.
 *
 * The split homes: overlay packing (build-independent) lives in
 * tests/vfs-overlay.spec.ts; the built-image suites that materialize emitted
 * `lib/` and require it through the real loader live in
 * tests/image-loadable.built.ts under vitest.built.config.ts.
 */
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { PackResult } from '../src/pack.ts'
import { configTrees, describePack, indexWorkspacePackages, previewFixtures } from '../src/repository.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

describe('workspace indexing', () => {
  it('indexes release, native, and experimental packages by manifest name', () => {
    const index = indexWorkspacePackages(repoRoot)
    expect(index.get('@deepseek-ai/dsh-timeout')).toBe(`${repoRoot}packages/util/timeout`)
    expect(index.get('@deepseek-ai/dsh-experimental-webworker-packer'))
      .toBe(`${repoRoot}packages/experimental/webworker-packer`)
    // The Landlock family publishes from `native/`, outside `packages/`.
    expect(index.get('@deepseek-ai/node-addon-landlock-run')).toBeDefined()
  })

  it('lets a package root own its subtree', () => {
    const index = indexWorkspacePackages(repoRoot)
    // Fixture trees (for example the preview example's nested files) live under
    // package roots; a package root that owns them means no directory below a
    // manifest is ever indexed as its own workspace.
    for (const directory of index.values()) {
      expect(directory.includes('/tests/')).toBe(false)
      expect(directory.includes('node_modules')).toBe(false)
    }
  })
})

describe('config tree declarations', () => {
  it('follows the CLI declaration to existing directories under distinct mounts', () => {
    const trees = configTrees(repoRoot)
    expect(trees.length).toBeGreaterThan(0)
    expect(new Set(trees.map(tree => tree.mount)).size).toBe(trees.length)
    for (const tree of trees) {
      expect(existsSync(tree.directory)).toBe(true)
    }
  })
})

describe('preview fixtures', () => {
  it('offers the showcase example as home and workspace overlay trees', () => {
    const fixtures = previewFixtures(repoRoot)
    expect(fixtures.map(fixture => fixture.id)).toEqual(['vfs-example'])
    const showcase = fixtures[0]
    if (showcase === undefined) throw new Error('previewFixtures returned no showcase entry')
    expect(showcase.label).not.toBe('')
    expect(showcase.description).not.toBe('')
    expect(showcase.trees.map(tree => tree.mount)).toEqual(['home', 'workspace'])
    for (const tree of showcase.trees) {
      expect(existsSync(tree.directory)).toBe(true)
    }
  })
})

describe('pack reporting', () => {
  const pack = (missing: readonly string[]): PackResult => ({
    image: new Uint8Array(2048),
    files: {
      'node_modules/left/lib/index.js': new Uint8Array(4096),
      'node_modules/left/package.json': new Uint8Array(256),
      'config/cordis.yml': new Uint8Array(512),
    },
    packages: new Map([['left', 2]]),
    workspacePackages: 1,
    roster: ['left'],
    missing,
    executables: ['bin/tool'],
    pageBundles: [],
    javascriptEntries: 3,
    droppedJavascriptEntries: 1,
    unresolvedExternalRequests: ['orphaned-driver'],
    transform: { visited: 4, rewritten: 3 },
    contract: 'lowering-v1',
  })

  it('renders a complete pack without an unresolved-dependencies section', () => {
    const lines = describePack(pack([]), repoRoot, `${repoRoot}dist/image.tar.gz`)
    expect(lines[0]).toBe('vfs image: dist/image.tar.gz')
    expect(lines.join('\n')).not.toContain('unresolved dependencies:')
    expect(lines.join('\n')).toContain('transform           3 of 4 reached entries rewritten, 1 unreachable dropped')
    expect(lines.join('\n')).toContain('unresolved          1 third-party request(s)')
  })

  it('spells out every missing dependency instead of counting them', () => {
    const lines = describePack(pack(['missing-a', 'missing-b']), repoRoot, `${repoRoot}dist/image.tar.gz`)
    expect(lines.join('\n')).toContain('unresolved dependencies:')
    expect(lines.join('\n')).toContain('    missing-a')
    expect(lines.join('\n')).toContain('    missing-b')
  })
})
