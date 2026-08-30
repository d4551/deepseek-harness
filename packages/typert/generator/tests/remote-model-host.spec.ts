/**
 * Dual-face Remote packages and missing-method publication.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { rmSync, writeFileSync } from 'node:fs'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import { copyFixture, editFile, temporaryRoots } from './remote-model-helpers.ts'
import { readObject, writeObject } from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Remote host-face publication', { timeout: 60_000 }, () => {
  it.each(['create#v2', 'create goal', '.', '..'])('rejects untransportable Remote alias %s', (alias) => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source.replace(
      '  @Remote\n  async create(',
      `  @Remote('${alias}')\n  async create(`,
    ))
    expect(() => new WorkspaceTypertGenerator(root).generate()).toThrow(/RPC endpoint segment characters/)
  })

  it('rejects a Remote export after its last Remote method is removed', () => {
    const root = copyFixture()
    editFile(root, 'packages/remote/src/index.ts', source => source
      .replaceAll('  @Remote\n', '')
      .replace("  @RemoteScope('agent')\n", '')
      .replace("  @Remote({ mode: 'stream' })\n", ''))
    editFile(root, 'packages/remote/src/types.ts', source => `${source}

/** @typert schema */
export interface RemainingSchema {
  readonly value: string
}
`)
    expect(() => new WorkspaceTypertGenerator(root).generate())
      .toThrow('publishes Remote artifacts but has no Remote methods')
  })

  it('validates Remote artifacts only on the host face of a dual-face package', () => {
    const root = copyFixture()
    const manifestPath = join(root, 'packages/remote/package.json')
    const manifest = readObject(manifestPath)
    Reflect.set(manifest, 'dsh', { client: {} })
    const exportsField = Reflect.get(manifest, 'exports')
    if (exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
      Reflect.set(exportsField, './client', './src/client.ts')
      Reflect.set(exportsField, './client/typert', {
        types: './lib/typert.client.d.ts',
        default: './lib/typert.client.js',
      })
    }
    const files = Reflect.get(manifest, 'files')
    if (Array.isArray(files)) files.push('lib/typert.client.js', 'lib/typert.client.d.ts')
    writeObject(manifestPath, manifest)
    writeObject(join(root, 'tsconfig.client.json'), {
      extends: './tsconfig.base.json',
      files: [],
      references: [{ path: './packages/remote' }],
    })
    writeFileSync(join(root, 'packages/remote/src/client.ts'), `/** @typert schema */
export interface ClientMarker {
  readonly ready: boolean
}
`)
    const artifacts = new WorkspaceTypertGenerator(root).generate()
    expect(artifacts.map(artifact => artifact.face)).toEqual(['host', 'client'])
    expect(artifacts.find(item => item.face === 'host')?.dts.includes('ClientMarker')).toBe(false)
    expect(artifacts.find(item => item.face === 'client')?.dts.includes('ClientMarker')).toBe(true)
  })
})
