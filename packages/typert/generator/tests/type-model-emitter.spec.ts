/**
 * FaceModelEmitter Zod JavaScript, declarations, and runtime metadata.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { FaceModelEmitter } from '../src/emitter.ts'
import {
  fixtureRoot,
  generatedSuccess,
  requiredObject,
  temporaryRoots,
} from './type-model-helpers.ts'
import { compileFiles } from './ts7-harness.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('FaceModelEmitter', { timeout: 60_000 }, () => {
  it('emits runnable Zod JavaScript, precise declarations, and runtime package metadata', async () => {
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
  })
})
