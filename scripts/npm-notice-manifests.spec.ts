import { describe, expect, it } from 'vitest'
import { localPackageDeclarations, type Manifest } from './npm-notice-manifests.ts'

describe('local package disclosure', () => {
  it('includes every dependency section and resolves paths from each declaring workspace', () => {
    const manifests = new Map<string, Manifest>([
      ['package.json', { devDependencies: { runner: 'file:./tooling/runner.tgz', published: '^1.0.0' } }],
      ['apps/web/package.json', {
        dependencies: { shared: 'file:../../packages/shared' },
        optionalDependencies: { native: 'file:../../native/package.tgz' },
        peerDependencies: { theme: 'file:./theme' },
      }],
      ['packages/service/package.json', { dependencies: { shared: 'file:../shared' } }],
    ])
    expect(localPackageDeclarations(manifests)).toEqual([
      { name: 'native', manifest: 'apps/web/package.json', kind: 'optionalDependencies', path: 'native/package.tgz' },
      { name: 'runner', manifest: 'package.json', kind: 'devDependencies', path: 'tooling/runner.tgz' },
      { name: 'shared', manifest: 'apps/web/package.json', kind: 'dependencies', path: 'packages/shared' },
      { name: 'shared', manifest: 'packages/service/package.json', kind: 'dependencies', path: 'packages/shared' },
      { name: 'theme', manifest: 'apps/web/package.json', kind: 'peerDependencies', path: 'apps/web/theme' },
    ])
  })

  it.each(['file:', 'file:../outside.tgz', 'file:/outside.tgz', 'file:C:\\outside.tgz', 'file:..', 'file:../..'])('rejects non-repository package path %s', (spec) => {
    expect(() => localPackageDeclarations(new Map([['package.json', { dependencies: { library: spec } }]])))
      .toThrow('must name a repository-local package')
  })

  it('reports no local dependencies for registry and workspace declarations', () => {
    expect(localPackageDeclarations(new Map([
      ['package.json', { dependencies: { one: '^1.0.0', two: 'workspace:*' } }],
      ['packages/service/package.json', {}],
    ]))).toEqual([])
  })

  it('retains runtime and development declarations of the same package', () => {
    expect(localPackageDeclarations(new Map([['package.json', {
      dependencies: { library: 'file:./runtime.tgz' },
      devDependencies: { library: 'file:./development.tgz' },
    }]]))).toEqual([
      { name: 'library', manifest: 'package.json', kind: 'dependencies', path: 'runtime.tgz' },
      { name: 'library', manifest: 'package.json', kind: 'devDependencies', path: 'development.tgz' },
    ])
  })

  it('normalizes Windows separators in manifest-relative paths', () => {
    expect(localPackageDeclarations(new Map([
      ['apps/web/package.json', { dependencies: { local: 'file:..\\..\\tooling\\local.tgz' } }],
    ]))).toEqual([{ name: 'local', manifest: 'apps/web/package.json', kind: 'dependencies', path: 'tooling/local.tgz' }])
  })
})
