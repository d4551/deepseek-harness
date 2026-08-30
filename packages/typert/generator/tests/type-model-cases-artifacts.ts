/**
 * Shared type-model case bodies for WorkspaceTypertGenerator artifacts and
 * FaceModelEmitter emission. Registered by type-model.spec.ts; the split
 * type-model-*.spec.ts files register the same functions.
 */

import { expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { FaceModelEmitter } from '../src/emitter.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import {
  copyFixture,
  fixtureRoot,
  generatedSuccess,
  readObject,
  requiredObject,
  temporaryRoots,
  writeObject,
} from './type-model-helpers.ts'
import { compileFiles } from './ts7-harness.ts'

export function emitsExactRootLevelArtifacts(): void {
  const artifacts = new WorkspaceTypertGenerator(fixtureRoot).generate()
  expect(artifacts.map(artifact => ({ package: artifact.package, face: artifact.face }))).toEqual([
    { package: '@fixture/host', face: 'host' },
    { package: '@fixture/client', face: 'client' },
  ])
  expect(artifacts.every(artifact => artifact.dts.includes('export declare const TYPERT: unknown'))).toBe(true)
}

export function rejectsMisplacedTypertSubpaths(): void {
  const root = copyFixture('typert-artifact-path-')
  const manifestPath = join(root, 'packages/client', 'package.json')
  const manifest = readObject(manifestPath)
  const exportsField = Reflect.get(manifest, 'exports')
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) {
    throw new Error('fixture has no client Typert export')
  }
  const clientExport = Reflect.get(exportsField, './client/typert')
  if (clientExport === null || typeof clientExport !== 'object' || Array.isArray(clientExport)) {
    throw new Error('fixture has no client Typert export')
  }
  Reflect.set(clientExport, 'types', './lib/types/typert.client.d.ts')
  writeObject(manifestPath, manifest)

  expect(() => new WorkspaceTypertGenerator(root).generate()).toThrow(
    '@fixture/client must export ./client/typert as',
  )
}

export function rejectsAbsentTypertExportsAndFiles(): void {
  const noSubpathRoot = copyFixture('typert-missing-artifact-export-')
  const noSubpathManifest = join(noSubpathRoot, 'packages/client', 'package.json')
  const noSubpath = readObject(noSubpathManifest)
  Reflect.set(noSubpath, 'exports', './lib/index.js')
  writeObject(noSubpathManifest, noSubpath)
  expect(() => new WorkspaceTypertGenerator(noSubpathRoot).generate()).toThrow(
    '@fixture/client must export ./client/typert as',
  )

  const invalidSubpathRoot = copyFixture('typert-invalid-artifact-export-')
  const invalidSubpathManifest = join(invalidSubpathRoot, 'packages/client', 'package.json')
  const invalidSubpath = readObject(invalidSubpathManifest)
  const invalidExports = Reflect.get(invalidSubpath, 'exports')
  if (invalidExports !== null && typeof invalidExports === 'object' && !Array.isArray(invalidExports)) {
    Reflect.set(invalidExports, './client/typert', null)
  }
  writeObject(invalidSubpathManifest, invalidSubpath)
  expect(() => new WorkspaceTypertGenerator(invalidSubpathRoot).generate()).toThrow(
    '@fixture/client must export ./client/typert as',
  )

  const noFilesRoot = copyFixture('typert-missing-artifact-files-')
  const noFilesManifest = join(noFilesRoot, 'packages/client', 'package.json')
  const noFiles = readObject(noFilesManifest)
  Reflect.deleteProperty(noFiles, 'files')
  writeObject(noFilesManifest, noFiles)
  expect(() => new WorkspaceTypertGenerator(noFilesRoot).generate()).toThrow(
    '@fixture/client package files must include lib/typert.client.js',
  )
}

export async function emitsRunnableZodArtifacts(): Promise<void> {
  const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
  const host = model.faces.find(face => face.face === 'host')
  if (host === undefined) throw new Error('fixture has no host face')
  const artifact = new FaceModelEmitter(host).emit('@fixture/host')

  expect(artifact.js).toMatchSnapshot()
  expect(artifact.dts).toMatchSnapshot()

  const root = mkdtempSync(join(import.meta.dirname, '.generated-model-'))
  temporaryRoots.push(root)
  const modulePath = join(root, 'host.mjs')
  writeFileSync(modulePath, artifact.js)
  const generated: object = await import(`${pathToFileURL(modulePath).href}?test=${String(Date.now())}`)
  const payload = requiredObject(generated, 'Payload')
  expect(generatedSuccess(payload, { name: 'ready', count: 2 })).toBe(true)
  expect(generatedSuccess(payload, { name: 'ready', count: 'two' })).toBe(false)
  const typert = requiredObject(generated, 'TYPERT')
  expect(typert).toMatchObject({ package: '@fixture/host', face: 'host' })
  const schemas = Reflect.get(typert, 'schemas')
  if (!Array.isArray(schemas) || schemas[0] === null || typeof schemas[0] !== 'object') {
    throw new Error('generated TYPERT has no schemas')
  }
  expect(Reflect.get(schemas[0], 'schema')).toBe(payload)
  const typertModel = requiredObject(typert, 'model')
  const services = Reflect.get(typertModel, 'services')
  if (!Array.isArray(services)) throw new Error('generated TYPERT has no services')
  const demo = services.find(service =>
    service !== null && typeof service === 'object' && Reflect.get(service, 'key') === 'demo')
  if (demo === null || typeof demo !== 'object') throw new Error('generated TYPERT has no demo service')
  expect(demo).toMatchObject({ key: 'demo' })
  const members = Reflect.get(demo, 'members')
  if (!Array.isArray(members)) throw new Error('demo service has no members')
  const signatures = members.flatMap((member) => {
    if (member === null || typeof member !== 'object') return []
    const signature = Reflect.get(member, 'signature')
    return typeof signature === 'string' ? [signature] : []
  })
  expect(signatures).toContain(
    'inspect(agent: Agent<{ ready: true }>, flags: Flags<Payload>): Present<Payload>',
  )

  const declarationPath = join(root, 'host.d.ts')
  const consumerPath = join(root, 'consumer.ts')
  const sourceStubPath = join(root, 'source.d.ts')
  writeFileSync(declarationPath, artifact.dts)
  writeFileSync(consumerPath, [
    "import { Payload } from './host.js'",
    "import type { Payload as SourcePayload } from '@fixture/host'",
    "import type { z } from 'zod'",
    'const precise: z.ZodType<SourcePayload> = Payload',
    'export { precise }',
    '',
  ].join('\n'))
  writeFileSync(sourceStubPath, [
    "declare module '@fixture/host' {",
    '  export interface Payload { name: string; count?: number }',
    '}',
    '',
  ].join('\n'))
  expect(compileFiles([consumerPath, declarationPath, sourceStubPath])).toEqual([])
}
