/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkBuildToolingClosure,
  checkSingleExternalVersion,
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  expectedDshPackageFiles,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('single external dependency version', () => {
  const manifest = (name: string, dependencies: Record<string, string>) =>
    ({ dir: name, manifest: { name, dependencies } })

  it('rejects two versions of one dependency and accepts one written two ways', () => {
    expect(checkSingleExternalVersion([
      manifest('a', { zod: '^4.5.4' }),
      manifest('b', { zod: '^4.4.3' }),
    ])).toEqual(['zod: one workspace version only, got 4.4.3 (b) vs 4.5.4 (a)'])
    // An exact pin and a caret on the same base version are one choice: apps
    // pin what libraries range over, and that is not drift.
    expect(checkSingleExternalVersion([
      manifest('a', { ws: '8.21.3' }),
      manifest('b', { ws: '^8.21.3' }),
    ])).toEqual([])
  })

  it('holds workspace members and vendored copies outside the rule', () => {
    // A workspace member is versioned by the repository, and the workspace:
    // protocol check owns it.
    expect(checkSingleExternalVersion([
      { dir: 'a', manifest: { name: 'a', dependencies: { b: 'workspace:*' } } },
      { dir: 'b', manifest: { name: 'b', dependencies: {} } },
    ])).toEqual([])
    // Vendored manifests are pinned copies of upstream and move only through
    // the vendor sync procedure.
    expect(checkSingleExternalVersion([
      manifest('a', { chokidar: '^5.0.0' }),
      { dir: 'vendor/hmr', manifest: { name: 'hmr', dependencies: { chokidar: '^4.0.3' } } },
    ])).toEqual([])
  })
})

describe('package payload constraints', () => {
  it('includes a declared profile patch without a package-name allowlist', () => {
    expect(expectedDshPackageFiles({
      name: '@deepseek-ai/dsh-private-profile',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })).toEqual([
      'lib/index.js',
      'lib/invariant.js',
      'cordis.patch.yml',
      'lib/types/**/*.d.ts',
    ])
  })
})

describe('build tooling dependency closure', () => {
  const config = "import { typertPlugin } from './packages/typert/generator/lib/types/tsdown-plugin.js'\n"
  const workspace: readonly WorkspaceManifest[] = [
    {
      dir: 'packages/typert/generator',
      manifest: {
        name: '@deepseek-ai/dsh-typert-generator',
        dependencies: { typescript: '^7.0.2' },
        peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
      },
    },
    { dir: 'packages/util/diagnostic-text', manifest: { name: '@deepseek-ai/dsh-diagnostic-text' } },
    { dir: 'vendor/cordis', manifest: { name: '@deepseek-ai/cordis' } },
  ]

  it('accepts an imported package that depends only on published packages', () => {
    expect(checkBuildToolingClosure(config, workspace)).toEqual([])
  })

  it('rejects a workspace runtime dependency on a package the same build bundles', () => {
    expect(checkBuildToolingClosure(config, [
      {
        dir: 'packages/typert/generator',
        manifest: {
          name: '@deepseek-ai/dsh-typert-generator',
          dependencies: { typescript: '^7.0.2', '@deepseek-ai/dsh-diagnostic-text': 'workspace:^' },
          peerDependencies: { '@deepseek-ai/cordis': 'workspace:^' },
        },
      },
      ...workspace.slice(1),
    ])).toEqual([
      '@deepseek-ai/dsh-typert-generator: tsdown.config.ts imports this package\'s emit, so dependencies.@deepseek-ai/dsh-diagnostic-text must not be a workspace package whose entry the same build writes',
    ])
  })

  it('leaves packages the config never imports to the other constraints', () => {
    expect(checkBuildToolingClosure("import { defineConfig } from 'tsdown'\n", [
      {
        dir: 'packages/typert/generator',
        manifest: {
          name: '@deepseek-ai/dsh-typert-generator',
          dependencies: { '@deepseek-ai/dsh-diagnostic-text': 'workspace:^' },
        },
      },
      ...workspace.slice(1),
    ])).toEqual([])
  })
})
