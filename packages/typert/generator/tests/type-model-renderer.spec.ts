/**
 * TypeGraphRenderer canonical syntax and cross-face rendering, plus the
 * analyzed-face hand-off into FaceModelEmitter.
 */

import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { FaceModelEmitter } from '../src/emitter.ts'
import { TypeGraphRenderer } from '../src/renderer.ts'
import { copyFixture, fixtureRoot, temporaryRoots } from './type-model-helpers.ts'
import { canonicalType, isInterfaceDeclaration, isPropertySignatureDeclaration, parseSource, printType } from './ts7-harness.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('TypeGraphRenderer', { timeout: 60_000 }, () => {
  it('renders every type node kind with canonical syntax', () => {
    const source = parseSource('fixture.ts', [
      'export interface Everything {',
      '  keyword: string',
      '  literal: "ready"',
      '  parenthesized: (string)',
      '  reference: Payload',
      '  union: string | number',
      '  intersection: string & number',
      '  array: string[]',
      '  tuple: [string, number]',
      '  object: { ready: true }',
      '  function: (value: string) => number',
      '  constructor: new (value: string) => number',
      "  'indexed-access': Payload['name']",
      '  operator: keyof Payload',
      '  conditional: string extends number ? true : false',
      '  infer: Payload extends { name: infer Name } ? Name : never',
      '  mapped: { [K in keyof Payload]: Payload[K] }',
      "  'template-literal': `prefix-${string}`",
      "  'type-query': typeof Payload",
      "  'import-type': import('@fixture/host').Payload",
      '  predicate: (value: never) => value is string',
      '  this: this',
      '}',
      'export interface Payload { name: string }',
    ].join('\n'))

    const declaration = source.statements.find(isInterfaceDeclaration)
    if (declaration === undefined) throw new Error('fixture interface did not parse')
    const rendered = declaration.members.flatMap((member) => {
      if (!isPropertySignatureDeclaration(member) || member.type === undefined) return []
      return [{
        name: member.name.getText(),
        type: canonicalType(printType(member.type)),
      }]
    })

    expect(rendered).toEqual([
      { name: 'keyword', type: 'string' },
      { name: 'literal', type: '"ready"' },
      { name: 'parenthesized', type: '(string)' },
      { name: 'reference', type: 'Payload' },
      { name: 'union', type: 'string | number' },
      { name: 'intersection', type: 'string & number' },
      { name: 'array', type: 'string[]' },
      { name: 'tuple', type: '[string, number]' },
      { name: 'object', type: '{ ready: true }' },
      { name: 'function', type: '(value: string) => number' },
      { name: 'constructor', type: 'new (value: string) => number' },
      { name: "'indexed-access'", type: 'Payload[\'name\']' },
      { name: 'operator', type: 'keyof Payload' },
      { name: 'conditional', type: 'string extends number ? true : false' },
      { name: 'infer', type: 'Payload extends { name: infer Name } ? Name : never' },
      { name: 'mapped', type: '{ [K in keyof Payload]: Payload[K] }' },
      { name: "'template-literal'", type: '`prefix-${string}`' },
      { name: "'type-query'", type: 'typeof Payload' },
      { name: "'import-type'", type: 'import(\'@fixture/host\').Payload' },
      { name: 'predicate', type: '(value: never) => value is string' },
      { name: 'this', type: 'this' },
    ])
  })

  it('renders a full workspace model with cross-face links', () => {
    const root = copyFixture('typert-renderer-workspace-')
    const model = new WorkspaceAnalyzer({ root }).analyze()
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'HostAgent',
    })
    const client = model.faces.find(face => face.face === 'client')
    if (client === undefined) throw new Error('fixture has no client face')
    const renderer = new TypeGraphRenderer(client.graph)
    const view = client.graph.declarations.find(declaration => declaration.name === 'ClientView')
    if (view === undefined) throw new Error('fixture has no ClientView declaration')
    const payload = view.members.find(member => member.kind === 'property' && member.name === 'payload')
    if (payload === undefined || payload.kind !== 'property') {
      throw new Error('ClientView has no payload property')
    }
    expect(canonicalType(renderer.renderType(payload.type))).toBe('Payload')
  })
})

describe('FaceModelEmitter', { timeout: 60_000 }, () => {
  it('emits the analyzed fixture host face with its export surface', () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
    const host = model.faces.find(face => face.face === 'host')
    if (host === undefined) throw new Error('fixture has no host face')
    const artifact = new FaceModelEmitter(host).emit('@fixture/host')
    expect(artifact).toMatchObject({ package: '@fixture/host', face: 'host' })
    expect(artifact.exports).toContain('Payload')
    expect(artifact.js).toContain('export const TYPERT')
    expect(artifact.dts).toContain('export declare const TYPERT')
  })
})
