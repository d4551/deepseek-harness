/**
 * TypeScript 7 compile and isolated-parse checks for Typert fixtures.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { TypeGraphRenderer } from '../src/renderer.ts'
import { WorkspaceTypertGenerator } from '../src/workspace.ts'
import {
  copyFixture,
  fixtureRoot,
  temporaryRoots,
  writeObject,
} from './type-model-helpers.ts'
import {
  canonicalType,
  compileFiles,
  isInterfaceDeclaration,
  isPropertySignature,
  parseOnDisk,
  projectFileNames,
} from './ts7-harness.ts'
import { isIdentifier } from 'typescript/unstable/ast/is'
import { mkdtempSync } from 'node:fs'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('TypeGraphRenderer', { timeout: 60_000 }, () => {
  it('retains every source-authored SyntaxZoo property type through rendering', () => {
    const host = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze().faces
      .find(face => face.face === 'host')
    if (host === undefined) throw new Error('fixture has no host face')
    const declaration = host.graph.declarations.find(candidate => candidate.name === 'SyntaxZoo')
    if (declaration === undefined) throw new Error('fixture has no SyntaxZoo declaration')
    const sourcePath = join(fixtureRoot, 'packages/host/src/models.ts')
    const source = parseOnDisk(sourcePath)
    const sourceDeclaration = source.statements
      .find(statement => isInterfaceDeclaration(statement) && statement.name.text === 'SyntaxZoo')
    if (sourceDeclaration === undefined || !isInterfaceDeclaration(sourceDeclaration)) {
      throw new Error('fixture source has no SyntaxZoo declaration')
    }
    const sourceTypes = new Map(sourceDeclaration.members.flatMap((member) => {
      if (!isPropertySignature(member) || member.type === undefined || !isIdentifier(member.name)) return []
      return [[member.name.text, member.type.getText(source)] as const]
    }))
    const renderer = new TypeGraphRenderer(host.graph)
    const renderedTypes = new Map(declaration.members.flatMap((member) => {
      if (member.kind !== 'property') return []
      return [[member.name, canonicalType(renderer.renderType(member.type))] as const]
    }))
    expect([...renderedTypes.keys()]).toEqual([...sourceTypes.keys()])
    for (const [name, sourceType] of sourceTypes) {
      expect(renderedTypes.get(name), name).toBe(canonicalType(sourceType))
    }
  })

  it('renders every analyzed declaration as compilable TypeScript', () => {
    const model = new WorkspaceAnalyzer({ root: fixtureRoot }).analyze()
    const root = mkdtempSync(join(import.meta.dirname, '.rendered-model-'))
    temporaryRoots.push(root)
    const rootNames: string[] = []
    for (const face of model.faces) {
      const renderer = new TypeGraphRenderer(face.graph)
      const path = join(root, `${face.face}.d.ts`)
      const prelude = face.face === 'host'
        ? ['declare class Service {}', 'interface ZodType<Output = unknown> {}']
        : ['declare class Service {}', 'declare class Agent<State = unknown> {}']
      writeFileSync(path, [...prelude, ...face.graph.declarations.map(declaration => renderer.renderDeclaration(declaration.id)), ''].join('\n\n'))
      rootNames.push(path)
    }
    expect(compileFiles(rootNames)).toEqual([])
  })
})

describe('WorkspaceTypertGenerator', { timeout: 60_000 }, () => {
  it('emits host and client faces through their exact root-level public artifacts', () => {
    const artifacts = new WorkspaceTypertGenerator(fixtureRoot).generate()
    expect(artifacts.map(artifact => ({ package: artifact.package, face: artifact.face }))).toEqual([
      { package: '@fixture/host', face: 'host' },
      { package: '@fixture/client', face: 'client' },
    ])
    expect(artifacts.every(artifact => artifact.dts.includes('export declare const TYPERT: unknown'))).toBe(true)
  })
})

describe('unscoped externals', { timeout: 60_000 }, () => {
  it('keeps unscoped global npm declarations as true external targets', () => {
    const root = copyFixture('typert-unscoped-external-')
    const externalRoot = join(root, 'node_modules/unscoped-global')
    mkdirSync(externalRoot, { recursive: true })
    writeObject(join(externalRoot, 'package.json'), { name: 'unscoped-global', version: '1.0.0', types: './index.d.ts' })
    writeFileSync(join(externalRoot, 'index.d.ts'), [
      'export {}',
      'declare global { interface UnscopedGlobal { readonly value: string } }',
      '',
    ].join('\n'))
    const names = projectFileNames(join(root, 'packages/host/tsconfig.json'))
    expect(names.some(name => name.replaceAll('\\', '/').endsWith('/unscoped-global/index.d.ts'))).toBe(true)
  })
})
