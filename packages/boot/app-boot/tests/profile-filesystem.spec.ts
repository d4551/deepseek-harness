import {
  mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  healProfilesModuleFallback, initProfile, loadProfile, resolveBundleDir, resolveProfileDir,
} from '../src/index.ts'

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function installation() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-filesystem-'))
  directories.push(root)
  const app = join(root, 'app')
  mkdirSync(app)
  const anchor = join(app, 'package.json')
  writeFileSync(anchor, JSON.stringify({ name: 'test-installation', version: '1.0.0' }))
  const home = join(root, 'home')
  const modules = join(home, 'profiles', 'node_modules')
  mkdirSync(modules, { recursive: true })
  return { root, app, anchor, home, modules }
}

it('repairs a module link whose target parent has disappeared', async () => {
  const { root, app, anchor, home, modules } = installation()
  const target = join(root, 'removed-parent', 'installation')
  const link = join(modules, 'test-installation')
  symlinkSync(target, link, 'junction')

  await healProfilesModuleFallback({ installAnchor: anchor, home })

  expect(readlinkSync(link)).toBe(realpathSync.native(app))
  expect(readFileSync(join(link, 'package.json'), 'utf8')).toBe(readFileSync(anchor, 'utf8'))
})

it('propagates a cyclic target-parent failure without replacing the existing link', async () => {
  const { root, anchor, home, modules } = installation()
  const cycle = join(root, 'cycle')
  symlinkSync(cycle, cycle, 'junction')
  const target = join(cycle, 'installation')
  const link = join(modules, 'test-installation')
  symlinkSync(target, link, 'junction')

  await expect(healProfilesModuleFallback({ installAnchor: anchor, home })).rejects.toMatchObject({ code: 'ELOOP' })

  expect(readlinkSync(link)).toBe(target)
})

it('preserves an owned projection when a foreign file blocks scoped cleanup', async () => {
  const { app, anchor, home } = installation()
  const bundle = join(app, 'node_modules', 'selected-bundle')
  const dependency = join(bundle, 'node_modules', '@scope', 'dependency')
  mkdirSync(dependency, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    name: 'selected-bundle', version: '1.0.0',
    dependencies: { '@scope/dependency': '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: '@scope/dependency', version: '1.0.0' }))
  const profileDir = resolveProfileDir('selected', home)
  initProfile(profileDir, ['selected-bundle'])
  const profile = loadProfile('filesystem-test', 'selected', anchor, home)
  await healProfilesModuleFallback({ installAnchor: anchor, profile, home })
  const owned = join(profileDir, '.dsh-module-fallback', 'node_modules', '@scope', 'dependency')
  const expectedTarget = readlinkSync(owned)
  const obstructed = join(profileDir, 'node_modules', '@scope')
  rmSync(obstructed, { recursive: true })
  writeFileSync(obstructed, 'caller-owned scope file\n')

  await expect(healProfilesModuleFallback({ installAnchor: anchor, profile: { ...profile, layers: [] }, home }))
    .rejects.toMatchObject({ code: 'ENOTDIR' })

  expect(readFileSync(obstructed, 'utf8')).toBe('caller-owned scope file\n')
  expect(readlinkSync(owned)).toBe(expectedTarget)
})

it('links dependencies of an unnamed application through native package resolution', async () => {
  const { app, anchor, home, modules } = installation()
  writeFileSync(anchor, JSON.stringify({ dependencies: { dependency: '1.0.0' } }))
  const dependency = join(app, 'node_modules', 'dependency')
  mkdirSync(dependency, { recursive: true })
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({ name: 'dependency', version: '1.0.0', main: './index.cjs' }))
  writeFileSync(join(dependency, 'index.cjs'), 'module.exports = "native dependency"\n')

  await healProfilesModuleFallback({ installAnchor: anchor, home })

  expect(readlinkSync(join(modules, 'dependency'))).toBe(realpathSync.native(dependency))
  const require = createRequire(join(home, 'profiles', 'consumer', 'package.json'))
  const value: unknown = require('dependency')
  expect(value).toBe('native dependency')
})

it('rejects a Node builtin as a bundle without inventing a filesystem package', () => {
  const { anchor, home } = installation()
  expect(() => resolveBundleDir('filesystem-test', 'node:fs', anchor, home)).toThrow('cannot resolve profile bundle')
})

it('resolves dependencies of an accepted local bundle whose manifest omits its name', async () => {
  const { app, anchor, home } = installation()
  const bundle = join(app, 'node_modules', 'local-bundle')
  const dependency = join(bundle, 'node_modules', 'private-dependency')
  const peer = join(bundle, 'node_modules', 'peer-dependency')
  const transitive = join(dependency, 'node_modules', 'transitive-dependency')
  mkdirSync(dependency, { recursive: true })
  mkdirSync(peer)
  mkdirSync(transitive, { recursive: true })
  writeFileSync(join(bundle, 'package.json'), JSON.stringify({
    version: '1.0.0', dependencies: { 'private-dependency': '1.0.0' },
    peerDependencies: { 'peer-dependency': '1.0.0' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(bundle, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(dependency, 'package.json'), JSON.stringify({
    name: 'private-dependency', version: '1.0.0', main: './index.cjs',
    dependencies: { 'transitive-dependency': '1.0.0' },
  }))
  writeFileSync(join(dependency, 'index.cjs'), 'module.exports = "local bundle dependency"\n')
  writeFileSync(join(peer, 'package.json'), JSON.stringify({ name: 'peer-dependency', version: '1.0.0', main: './index.cjs' }))
  writeFileSync(join(peer, 'index.cjs'), 'module.exports = "local bundle peer"\n')
  writeFileSync(join(transitive, 'package.json'), JSON.stringify({ name: 'transitive-dependency', version: '1.0.0', main: './index.cjs' }))
  writeFileSync(join(transitive, 'index.cjs'), 'module.exports = "transitive dependency"\n')
  const profileDir = resolveProfileDir('unnamed-bundle', home)
  initProfile(profileDir, ['local-bundle'])
  const profile = loadProfile('filesystem-test', 'unnamed-bundle', anchor, home)
  expect(profile.layers.map(layer => layer.packageName)).toEqual(['local-bundle'])

  await healProfilesModuleFallback({ installAnchor: anchor, profile, home })

  const require = createRequire(join(profileDir, 'consumer.cjs'))
  const value: unknown = require('private-dependency')
  const peerValue: unknown = require('peer-dependency')
  const transitiveValue: unknown = require('transitive-dependency')
  expect(value).toBe('local bundle dependency')
  expect(peerValue).toBe('local bundle peer')
  expect(transitiveValue).toBe('transitive dependency')
  expect(readlinkSync(join(profileDir, 'node_modules', 'private-dependency')))
    .toBe(join(profileDir, '.dsh-module-fallback', 'node_modules', 'private-dependency'))
})
