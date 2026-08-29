/**
 * WorkspaceAnalyzer face-model tests.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { rmSync } from 'node:fs'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  addExplicitServicePackage,
  copyFixture,
  fixtureRoot,
  temporaryRoots,
} from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceAnalyzer', { timeout: 60_000 }, () => {
  it('builds independent face models with an explicit cross-face type graph', () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
    expect(model.faces.map(face => face.face)).toEqual(['host', 'client'])
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'Agent',
    })
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'HostAgent',
    })
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'Box',
    })
    const clientPackage = model.faces.find(face => face.face === 'client')?.packages[0]
    expect(clientPackage).toMatchObject({ objects: [], schemas: [] })
    expect(clientPackage?.exports).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ReexportedBox', aliases: ['ReexportedBox', 'Box'] }),
      expect.objectContaining({ name: 'ReexportedZodType', aliases: ['ReexportedZodType', 'ZodType'] }),
    ]))
    const host = model.faces.find(face => face.face === 'host')
    expect(host?.graph.nodes).toContainEqual(expect.objectContaining({ kind: 'conditional' }))
    expect(host?.graph.nodes).toContainEqual(expect.objectContaining({ kind: 'mapped' }))
    expect(host?.graph.nodes.some(node => node.kind === 'reference'
      && node.target.kind === 'external'
      && node.target.module === 'zod'
      && node.target.name === 'ZodType')).toBe(true)
    expect(host?.graph.nodes.some(node => node.kind === 'reference'
      && node.target.kind === 'external'
      && node.target.module === '@types/node'
      && node.target.name === 'Process')).toBe(true)
    const agent = host?.graph.declarations.find(declaration => declaration.name === 'Agent')
    expect(agent?.implements).toHaveLength(1)
    expect(agent).toMatchObject({
      exported: true,
      location: { file: 'packages/host/src/index.ts' },
    })
    expect(agent?.text).toContain('export class Agent<State extends object = {')
    expect(agent?.members.map(member => member.name)).toEqual(['id', 'state', 'label', 'label', 'run'])
    const service = host?.packages[0]?.services.find(candidate => candidate.key === 'demo')
    const members = new Map(host?.graph.declarations
      .flatMap(declaration => declaration.members)
      .map(member => [member.id, member.name]))
    expect(service?.members.map(member => members.get(member))).toEqual([
      'inspect',
      'acceptsExternal',
      'setPhase',
      'inspectSyntax',
      'inspectAsync',
      'destructure',
    ])
    expect(service?.location).toMatchObject({ file: 'packages/host/src/index.ts' })
    const inspect = host?.graph.declarations
      .flatMap(declaration => declaration.members)
      .find(member => member.name === 'inspect')
    expect(inspect?.text).toBe(
      'inspect(agent: Agent<{ ready: true }>, flags: Flags<Payload>): Present<Payload>',
    )
    expect(host?.packages[0]?.services.filter(candidate => candidate.key === 'demo')).toHaveLength(1)
    expect(host?.packages[0]?.events.filter(candidate => candidate.name === 'demo/ready')).toHaveLength(1)
    expect(host?.packages[0]?.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'demo/unmodeled' }),
      expect.objectContaining({ name: 'demo/serial-property', mode: 'serial' }),
    ]))
    expect(host?.packages[0]?.events.find(candidate => candidate.name === 'demo/unmodeled'))
      .not.toHaveProperty('mode')
    expect(host?.packages[0]?.events.find(candidate => candidate.name === 'demo/ready')).toMatchObject({
      location: { file: 'packages/host/src/index.ts' },
      text: "'demo/ready'(agent: Agent<{ ready: true }>, payload: Box<Payload>): void",
    })
    expect(model).toMatchSnapshot()
  })

  it('merges bounded package programs into the same face model', () => {
    const options = {
      root: fixtureRoot,
      packages: ['@fixture/host', '@fixture/client'],
    } as const
    const direct = new WorkspaceAnalyzer(options).analyze()
    const batched = new WorkspaceAnalyzer(options).analyzeInBatches(1)
    expect(batched).toEqual(direct)
  })

  it('discovers an explicitly keyed service implementation without a Context merge', () => {
    const root = copyFixture('explicit-service-')
    addExplicitServicePackage(root, 'service detached')
    const analyzer = new WorkspaceAnalyzer({ root })
    expect(analyzer.discoverPackages()).toContainEqual({
      package: '@fixture/explicit-service',
      root: 'packages/explicit-service',
      faces: ['host'],
    })
    const model = new WorkspaceAnalyzer({ root, packages: ['@fixture/explicit-service'] }).analyze()
    expect(model.faces[0]?.packages[0]?.services[0]).toMatchObject({
      key: 'detached',
      export: { name: 'DetachedService' },
    })
  })

  it('prefers an explicitly keyed implementation over its protocol Context merge', () => {
    const root = copyFixture('explicit-service-protocol-')
    addExplicitServicePackage(root, 'service detached', true)
    const model = new WorkspaceAnalyzer({
      root,
      packages: ['@fixture/explicit-service'],
    }).analyze()
    expect(model.faces[0]?.packages[0]?.services[0]).toMatchObject({
      key: 'detached',
      export: { name: 'DetachedService' },
      location: { file: 'packages/explicit-service/src/index.ts' },
    })
  })

  it('rejects an explicit service implementation without one valid key', () => {
    const missing = copyFixture('explicit-service-missing-')
    addExplicitServicePackage(missing, 'service')
    expect(() => new WorkspaceAnalyzer({
      root: missing,
      packages: ['@fixture/explicit-service'],
    }).analyze()).toThrow('@typert service requires exactly one nonempty Cordis service key')
    const invalid = copyFixture('explicit-service-invalid-')
    addExplicitServicePackage(invalid, 'service bad/key')
    expect(() => new WorkspaceAnalyzer({
      root: invalid,
      packages: ['@fixture/explicit-service'],
    }).analyze()).toThrow('@typert service requires exactly one nonempty Cordis service key')
  })

  it('indexes authored top-level exports without promoting them to graph roots', () => {
    const declarations = new WorkspaceAnalyzer({ root: fixtureRoot }).indexSourceDeclarations()
    const agent = declarations.find(declaration => declaration.name === 'Agent')
    expect(agent).toMatchObject({
      face: 'host',
      package: '@fixture/host',
      name: 'Agent',
      kind: 'class',
    })
    expect(agent?.location).toMatchObject({ file: 'packages/host/src/index.ts' })
    expect(agent?.text).toContain('export class Agent<State extends object = {')
    expect(declarations.some(declaration => declaration.name === 'IgnoredDeclaration')).toBe(false)
  })
})
