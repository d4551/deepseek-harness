/** Derivation of the workspace packages a tsdown config resolves at load. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildToolingWorkspace, configToolingPackages } from './build-tooling-closure.ts'

const root = resolve(import.meta.dirname, '..')
const hostConfig = readFileSync(resolve(root, 'tsdown.config.ts'), 'utf8')

describe('config tooling packages', () => {
  it('names the package a relative plugin import reaches into', () => {
    expect(configToolingPackages(root, "import { p } from './packages/typert/generator/lib/types/tsdown-plugin.js'"))
      .toEqual([resolve(root, 'packages/typert/generator')])
  })

  it('ignores bare specifiers and repository files outside every package', () => {
    expect(configToolingPackages(root, "import { defineConfig } from 'tsdown'\nimport x from './scripts/build.ts'"))
      .toEqual([])
  })

  it('names each package once however many files the config imports from it', () => {
    expect(configToolingPackages(
      root,
      "import a from './packages/typert/generator/lib/types/tsdown-plugin.js'\n"
      + "import b from './packages/typert/generator/lib/types/model.js'",
    )).toEqual([resolve(root, 'packages/typert/generator')])
  })
})

describe('build tooling workspace', () => {
  it('carries the tooling package and the workspace dependencies behind it', () => {
    const workspace = buildToolingWorkspace(root, hostConfig)
    expect(workspace).toContain('packages/typert/generator')
    expect(workspace).toContain('packages/util/diagnostic-text')
    expect([...workspace]).toEqual([...workspace].sort())
  })

  it('refuses a config with no workspace package to bundle', () => {
    expect(() => buildToolingWorkspace(root, "import { defineConfig } from 'tsdown'"))
      .toThrow(/nothing to bundle/)
  })
})
