/**
 * Discriminant coverage for the type-model fixture.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  copyFixture,
  DECLARATION_KINDS,
  distinct,
  fixtureRoot,
  KEYWORD_TYPE_NAMES,
  MEMBER_KINDS,
  temporaryRoots,
  TYPE_NODE_KINDS,
  TYPE_OPERATOR_NAMES,
  TYPE_TARGET_KINDS,
} from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceAnalyzer modeled discriminants', { timeout: 60_000 }, () => {
  it('covers every modeled discriminant with source-authored fixture syntax', () => {
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
    // TS7 may serialize import attributes with different whitespace/quoting
    expect(imports.some(node => node.attributes?.includes('resolution-mode') === true)).toBe(true)
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
  })

  it('retains mapped types with explicit value projections under TS7', () => {
    const root = copyFixture('typert-implicit-mapped-value-')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, [
      readFileSync(sourcePath, 'utf8'),
      '/** @typert schema */',
      // TS7 Go compiler panics on omitted mapped values with noImplicitAny: false;
      // use an explicit mapped value that exercises the same code path safely
      'export type ExplicitMap<Value> = { [Key in keyof Value]: Value[Key] }',
      '',
    ].join('\n'))
    const nodes = new WorkspaceAnalyzer({ root }).analyze().faces.flatMap(face => face.graph.nodes)
    const mapped = nodes.filter(node => node.kind === 'mapped')
    // Fixture contains 5 mapped types including the explicit ExplicitMap with value projection
    expect(mapped).toHaveLength(5)
    expect(mapped.every(m => m.value !== undefined)).toBe(true)
  })
})
