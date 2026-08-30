/**
 * Shared type-model case bodies for face graphs and discriminants.
 * Registered by type-model.spec.ts; the split type-model-*.spec.ts files
 * register the same functions.
 */

import { expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  addExplicitServicePackage,
  copyFixture,
  DECLARATION_KINDS,
  distinct,
  fixtureRoot,
  KEYWORD_TYPE_NAMES,
  MEMBER_KINDS,
  readObject,
  TYPE_NODE_KINDS,
  TYPE_OPERATOR_NAMES,
  TYPE_TARGET_KINDS,
  writeObject,
} from './type-model-helpers.ts'

export function buildsFaceModelsWithCrossFaceGraph(): void {
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
  expect(host?.graph.nodes).toContainEqual(expect.objectContaining({
    kind: 'conditional',
  }))
  expect(host?.graph.nodes).toContainEqual(expect.objectContaining({
    kind: 'mapped',
  }))
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
}

export function mergesBoundedPackagePrograms(): void {
  const options = {
    root: fixtureRoot,
    packages: ['@fixture/host', '@fixture/client'],
  }
  const direct = new WorkspaceAnalyzer(options).analyze()
  const batched = new WorkspaceAnalyzer(options).analyzeInBatches(1)

  expect(batched).toEqual(direct)
}

export function discoversExplicitKeyedService(): void {
  const root = copyFixture('explicit-service-')
  addExplicitServicePackage(root, 'service detached')
  const analyzer = new WorkspaceAnalyzer({ root })

  expect(analyzer.discoverPackages()).toContainEqual({
    package: '@fixture/explicit-service',
    root: 'packages/explicit-service',
    faces: ['host'],
  })
  const model = new WorkspaceAnalyzer({ root, packages: ['@fixture/explicit-service'] }).analyze()
  const service = model.faces[0]?.packages[0]?.services[0]
  expect(service).toMatchObject({ key: 'detached', export: { name: 'DetachedService' } })
}

export function prefersExplicitKeyedImplementation(): void {
  const root = copyFixture('explicit-service-protocol-')
  addExplicitServicePackage(root, 'service detached', true)
  const model = new WorkspaceAnalyzer({
    root,
    packages: ['@fixture/explicit-service'],
  }).analyze()
  const service = model.faces[0]?.packages[0]?.services[0]

  expect(service).toMatchObject({
    key: 'detached',
    export: { name: 'DetachedService' },
    location: { file: 'packages/explicit-service/src/index.ts' },
  })
}

export function rejectsExplicitServiceWithoutValidKey(): void {
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
}

export function indexesAuthoredTopLevelExports(): void {
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
}

export function coversEveryModeledDiscriminant(): void {
  const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
  const nodes = model.faces.flatMap(face => face.graph.nodes)
  const declarations = model.faces.flatMap(face => face.graph.declarations)
  const members = declarations.flatMap(declaration => declaration.members)
  const objectMembers = nodes.flatMap(node => node.kind === 'object' ? node.members : [])
  const allMembers = [...members, ...objectMembers]
  const targets = nodes.flatMap(node => node.kind === 'reference' ? [node.target] : [])

  expect(distinct(nodes.map(node => node.kind))).toEqual(Object.keys(TYPE_NODE_KINDS).sort())
  expect(distinct(targets.map(target => target.kind))).toEqual(Object.keys(TYPE_TARGET_KINDS).sort())
  expect(distinct(nodes.flatMap(node => node.kind === 'keyword' ? [node.name] : [])))
    .toEqual(Object.keys(KEYWORD_TYPE_NAMES).sort())
  expect(distinct(nodes.flatMap(node => node.kind === 'operator' ? [node.operator] : [])))
    .toEqual(Object.keys(TYPE_OPERATOR_NAMES).sort())
  expect(distinct(declarations.map(declaration => declaration.kind))).toEqual(Object.keys(DECLARATION_KINDS).sort())
  expect(distinct(members.map(member => member.kind))).toEqual(Object.keys(MEMBER_KINDS).sort())
  expect(allMembers.some(member => member.optional)).toBe(true)
  expect(allMembers.some(member => member.readonly)).toBe(true)
  expect(allMembers.some(member => member.async)).toBe(true)
  expect(distinct(allMembers.map(member => String(member.abstract)))).toEqual(['false', 'true'])
  expect(allMembers.every(member => !member.static && member.visibility === 'public')).toBe(true)

  const signatures = [
    ...members.flatMap(member => 'signature' in member ? [member.signature] : []),
    ...nodes.flatMap(node => node.kind === 'function' || node.kind === 'constructor' ? [node.signature] : []),
  ]
  const typeParameters = declarations.flatMap(declaration => [
    ...declaration.typeParameters,
    ...declaration.members.flatMap(member => 'signature' in member ? member.signature.typeParameters : []),
    ...signatures.flatMap(signature => signature.typeParameters),
  ])
  expect(distinct(typeParameters.map(parameter => String(parameter.const)))).toEqual(['false', 'true'])
  expect(distinct(typeParameters.flatMap(parameter => parameter.variance === undefined ? [] : [parameter.variance])))
    .toEqual(['in', 'in-out', 'out'])

  const parameters = signatures.flatMap(signature => signature.parameters)
  expect(parameters.some(parameter => parameter.optional)).toBe(true)
  expect(parameters.some(parameter => parameter.rest)).toBe(true)
  expect(parameters.some(parameter => parameter.receiver)).toBe(true)

  const tuples = nodes.filter(node => node.kind === 'tuple')
  expect(tuples.some(tuple => tuple.elements.some(element => element.optional))).toBe(true)
  expect(tuples.some(tuple => tuple.elements.some(element => element.rest))).toBe(true)

  const mapped = nodes.filter(node => node.kind === 'mapped')
  expect(distinct(mapped.map(node => node.readonly))).toEqual(['add', 'preserve', 'remove'])
  expect(distinct(mapped.map(node => node.optional))).toEqual(['add', 'preserve', 'remove'])
  expect(mapped.some(node => node.nameType !== undefined)).toBe(true)
  const genericHeritage = declarations
    .flatMap(declaration => [...declaration.extends, ...declaration.implements])
    .map(id => nodes.find(node => node.id === id))
    .find(node => node?.kind === 'reference' && node.arguments.length > 0)
  expect(genericHeritage?.kind).toBe('reference')
  if (genericHeritage?.kind === 'reference') {
    expect(genericHeritage.name).toBe('Box')
    expect(genericHeritage.arguments).toHaveLength(1)
    expect(typeof genericHeritage.arguments[0]).toBe('string')
  }

  expect(parameters).toEqual(expect.arrayContaining([
    expect.objectContaining({ name: '{ name }', binding: 'object' }),
    expect.objectContaining({ name: '[suffix]', binding: 'array' }),
  ]))
  expect(parameters.some(parameter => parameter.binding === 'identifier')).toBe(true)

  const imports = nodes.filter(node => node.kind === 'import-type')
  expect(distinct(imports.map(node => String(node.typeof)))).toEqual(['false', 'true'])
  expect(imports.some(node => node.qualifier !== undefined && node.arguments.length > 0)).toBe(true)
  expect(imports.some(node => node.qualifier === undefined && node.arguments.length === 0)).toBe(true)
  expect(imports.some(node => node.attributes === "{ with: { 'resolution-mode': 'import' } }")).toBe(true)
  expect(imports.some(node => node.module === '@fixture/host'
    && node.qualifier === 'Agent'
    && node.target?.kind === 'cross-face'
    && node.target.name === 'Agent')).toBe(true)

  const literals = nodes.filter(node => node.kind === 'literal')
  expect(distinct(literals.map(node => node.value === null ? 'null' : typeof node.value)))
    .toEqual(['bigint', 'boolean', 'null', 'number', 'string'])
  expect(literals).toEqual(expect.arrayContaining([
    expect.objectContaining({ value: 1n, text: '1n' }),
    expect.objectContaining({ value: -2n, text: '-2n' }),
    expect.objectContaining({ value: 'fixed', text: '`fixed`' }),
  ]))

  const queries = nodes.filter(node => node.kind === 'type-query')
  expect(distinct(queries.map(node => String(node.arguments.length)))).toEqual(['0', '1'])
  const genericFactory = queries.find(node => node.expression === 'genericFactory')
  expect(genericFactory?.arguments).toHaveLength(1)
  expect(typeof genericFactory?.arguments[0]).toBe('string')

  const templates = nodes.filter(node => node.kind === 'template-literal')
  expect(templates.some(node => node.spans.length === 2
    && node.spans.map(span => span.text).join('|') === '/to/|/end')).toBe(true)

  const constructors = nodes.filter(node => node.kind === 'constructor')
  expect(distinct(constructors.map(node => String(node.abstract)))).toEqual(['false', 'true'])

  const predicates = nodes.filter(node => node.kind === 'predicate')
  expect(distinct(predicates.map(node => String(node.asserts)))).toEqual(['false', 'true'])
  expect(predicates.some(node => node.type === undefined)).toBe(true)
  expect(predicates.some(node => node.type !== undefined)).toBe(true)
  expect(predicates.some(node => node.parameter === 'this')).toBe(true)

  const enumMembers = declarations.flatMap(declaration => declaration.enumMembers ?? [])
  expect(enumMembers.some(member => member.initializer === undefined)).toBe(true)
  expect(enumMembers.some(member => member.initializer !== undefined)).toBe(true)
}

export function retainsOmittedMappedValue(): void {
  const root = copyFixture('typert-implicit-mapped-value-')
  const sourcePath = join(root, 'packages/host/src/index.ts')
  writeFileSync(sourcePath, [
    readFileSync(sourcePath, 'utf8'),
    '/** @typert schema */',
    'export type ImplicitMap<Value> = { [Key in keyof Value] }',
    '',
  ].join('\n'))
  const configPath = join(root, 'packages/host/tsconfig.json')
  const config = readObject(configPath)
  const options = Reflect.get(config, 'compilerOptions')
  if (options !== null && typeof options === 'object' && !Array.isArray(options)) {
    Reflect.set(options, 'noImplicitAny', false)
  }
  writeObject(configPath, config)

  const nodes = new WorkspaceAnalyzer({ root }).analyze().faces
    .flatMap(face => face.graph.nodes)
  const mapped = nodes.find(node => node.kind === 'mapped' && node.value === undefined)
  expect(mapped).toEqual(expect.objectContaining({ kind: 'mapped' }))
  expect(mapped).not.toHaveProperty('value')
}
