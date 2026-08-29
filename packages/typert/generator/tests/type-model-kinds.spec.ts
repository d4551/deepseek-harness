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
  writeObject,
  readObject,
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
    const imports = nodes.filter(node => node.kind === 'import-type')
    expect(distinct(imports.map(node => String(node.typeof)))).toEqual(['false', 'true'])
    const literals = nodes.filter(node => node.kind === 'literal')
    expect(distinct(literals.map(node => node.value === null ? 'null' : typeof node.value)))
      .toEqual(['bigint', 'boolean', 'null', 'number', 'string'])
  })

  it('retains an omitted mapped value when the owning project permits implicit any', () => {
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
    const nodes = new WorkspaceAnalyzer({ root }).analyze().faces.flatMap(face => face.graph.nodes)
    const mapped = nodes.find(node => node.kind === 'mapped' && node.value === undefined)
    expect(mapped).toEqual(expect.objectContaining({ kind: 'mapped' }))
    expect(mapped).not.toHaveProperty('value')
  })
})
