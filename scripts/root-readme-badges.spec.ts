/**
 * The root README badges state versions this repository actually pins.
 *
 * A badge is a claim a reader believes without checking, and nothing else reads
 * it, so a toolchain bump leaves it asserting a version the repository stopped
 * using. Each badge here is derived from `package.json`, and both language
 * sides carry the identical block so a bump cannot land in one and not the
 * other.
 * @module scripts/root-readme-badges.spec
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')

/** The badges at the top of one README, in order. */
function badgeBlock(file: string): string[] {
  // One physical line per paragraph is the repository's markdown rule, so the
  // badges sit on a single line and are read out of it rather than off lines.
  const [line = ''] = readFileSync(resolve(root, file), 'utf8')
    .split('\n')
    .filter(text => text.startsWith('[!['))
  return [...line.matchAll(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/gu)].map(found => found[0])
}

/** The declared version of one dependency, without its range prefix. */
function pinned(name: string): string {
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  const range = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name]
  if (range === undefined) throw new Error(`root package.json declares no ${name}`)
  return range.replace(/^[\^~]/, '')
}

describe('root README badges', () => {
  it('states the TypeScript version the repository compiles with', () => {
    expect(badgeBlock('README.md').join('\n')).toContain(`TypeScript-${pinned('typescript')}-`)
  })

  it('states the bun version packageManager pins', () => {
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { packageManager: string }
    const [, version = ''] = /^bun@(\d+\.\d+)/u.exec(manifest.packageManager) ?? []
    expect(version).not.toBe('')
    expect(badgeBlock('README.md').join('\n')).toContain(`bun-${version}-`)
  })

  it('states the major Vitest version the repository runs', () => {
    expect(badgeBlock('README.md').join('\n')).toContain(`Vitest-${pinned('vitest').split('.')[0]}-`)
  })

  it('carries the identical badge block on both language sides', () => {
    expect(badgeBlock('README.zh.md')).toEqual(badgeBlock('README.md'))
    expect(badgeBlock('README.md').length).toBeGreaterThan(0)
  })
})
