/**
 * WorkspaceTypertGenerator artifact generation tests.
 */

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import {
  copyFixture,
  readObject,
  requiredObject,
  temporaryRoots,
  writeObject,
} from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function clientManifestPath(root: string) {
  return join(root, 'packages/client', 'package.json')
}

function mutateClientManifest(root: string, mutate: (manifest: object) => void) {
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
    new WorkspaceTypertGenerator(root).generate()

    expect(readFileSync(join(root, 'packages/client', 'lib/typert.client.js'), 'utf8'))
      .toContain('export const TYPERT')
    expect(readFileSync(join(root, 'packages/client', 'lib/typert.client.d.ts'), 'utf8'))
      .toContain('export declare const TYPERT')
  })

  it('rewrites the client Typert export to the generated declaration', () => {
    const root = copyFixture('typert-generator-')
    mutateClientManifest(root, (manifest) => {
      const exportsField = requiredObject(manifest, 'exports')
      const clientExport = Reflect.get(exportsField, './client/typert')
      if (clientExport === undefined || typeof clientExport !== 'object' || clientExport === null) {
        throw new Error('fixture has no client Typert export')
      }
      Reflect.set(clientExport, 'types', './lib/types/typert.client.d.ts')
    })
    new WorkspaceTypertGenerator(root).generate()

    const rewritten = readObject(clientManifestPath(root))
    const rewrittenExports = requiredObject(rewritten, 'exports')
    const rewrittenClient = Reflect.get(rewrittenExports, './client/typert')
    if (rewrittenClient === undefined || typeof rewrittenClient !== 'object' || rewrittenClient === null) {
      throw new Error('rewritten manifest has no client Typert export')
    }
    expect(Reflect.get(rewrittenClient, 'types')).toBe('./lib/typert.client.d.ts')
  })

  it('rejects a client package without a Typert export subpath', () => {
    const root = copyFixture('typert-missing-artifact-export-')
    mutateClientManifest(root, manifest => Reflect.set(manifest, 'exports', './lib/index.js'))

    expectGeneratorRejection(root, '@fixture/client must export ./client/typert as')
  })

  it('rejects a client package whose Typert export is not a condition map', () => {
    const root = copyFixture('typert-invalid-artifact-export-')
    mutateClientManifest(root, (manifest) => {
      const exportsField = requiredObject(manifest, 'exports')
      Reflect.set(exportsField, './client/typert', null)
    })

    expectGeneratorRejection(root, '@fixture/client must export ./client/typert as')
  })

  it('rejects a client package whose files list omits the generated artifact', () => {
    const root = copyFixture('typert-missing-artifact-files-')
    mutateClientManifest(root, manifest => Reflect.deleteProperty(manifest, 'files'))

    expectGeneratorRejection(root, '@fixture/client package files must include lib/typert.client.js')
  })
})
