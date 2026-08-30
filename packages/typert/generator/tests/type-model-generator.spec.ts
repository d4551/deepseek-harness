/**
 * WorkspaceTypertGenerator artifact generation tests.
 */

import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import {
  copyFixture,
  readObject,
  requiredObject,
  temporaryRoots,
  writeObject,
  type JsonRecord,
} from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function clientManifestPath(root: string) {
  return join(root, 'packages/client', 'package.json')
}

function mutateClientManifest(root: string, mutate: (manifest: JsonRecord) => void) {
  const manifestPath = clientManifestPath(root)
  const manifest = readObject(manifestPath)
  mutate(manifest)
  writeObject(manifestPath, manifest)
}

function expectGeneratorRejection(root: string, message: string) {
  expect(() => new WorkspaceTypertGenerator(root).generate()).toThrow(message)
}

describe('WorkspaceTypertGenerator', { timeout: 60_000 }, () => {
  it('generates client Typert artifacts for every client package', () => {
    const root = copyFixture('typert-generator-')
    const artifacts = new WorkspaceTypertGenerator(root).generate()

    const clientArtifact = artifacts.find(a => a.face === 'client')
    expect(clientArtifact?.face).toBe('client')
    expect(clientArtifact?.js).toContain('export const TYPERT')
    expect(clientArtifact?.dts).toContain('export declare const TYPERT')
  })

  it('validates the client Typert export matches the generated declaration path', () => {
    const root = copyFixture('typert-generator-')
    mutateClientManifest(root, (manifest) => {
      const exportsField = requiredObject(manifest, 'exports')
      const clientExport = exportsField['./client/typert']
      if (clientExport === undefined || typeof clientExport !== 'object' || clientExport === null) {
        throw new Error('fixture has no client Typert export')
      }
      Reflect.set(clientExport, 'types', './lib/types/typert.client.d.ts')
    })
    // TS7 generator validates export paths but does not rewrite manifests directly;
    // the tsdown plugin handles rewriting during build
    expect(() => new WorkspaceTypertGenerator(root).generate())
      .toThrow('must export ./client/typert')
  })

  it('rejects a client package without a Typert export subpath', () => {
    const root = copyFixture('typert-missing-artifact-export-')
    mutateClientManifest(root, (manifest) => { manifest['exports'] = './lib/index.js' })

    expectGeneratorRejection(root, '@fixture/client must export ./client/typert as')
  })

  it('rejects a client package whose Typert export is not a condition map', () => {
    const root = copyFixture('typert-invalid-artifact-export-')
    mutateClientManifest(root, (manifest) => {
      const exportsField = requiredObject(manifest, 'exports')
      exportsField['./client/typert'] = null
    })

    expectGeneratorRejection(root, '@fixture/client must export ./client/typert as')
  })

  it('rejects a client package whose files list omits the generated artifact', () => {
    const root = copyFixture('typert-missing-artifact-files-')
    mutateClientManifest(root, manifest => Reflect.deleteProperty(manifest, 'files'))

    expectGeneratorRejection(root, '@fixture/client package files must include lib/typert.client.js')
  })
})
