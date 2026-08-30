import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { readObject, setCompilerOption, writeObject } from './type-model-helpers.ts'

const fixtureRoot = join(import.meta.dirname, 'fixtures/type-model')

function enableAmbientTypeRoots(root: string) {
  const packageConfigPath = join(root, 'packages/host/tsconfig.json')
  for (const configPath of [packageConfigPath, join(root, 'tsconfig.host.json')]) {
    const config = readObject(configPath)
    setCompilerOption(config, 'typeRoots', [
      configPath === packageConfigPath ? '../../node_modules' : './node_modules',
      resolve('node_modules/@types'),
    ])
    setCompilerOption(config, 'types', ['unscoped-global', 'node'])
    writeObject(configPath, config)
  }
}

describe('probe', () => {
  it('prints all declaration names for merged fixture', () => {
    const root = mkdtempSync(join(import.meta.dirname, '.probe-merge-'))
    cpSync(fixtureRoot, root, { recursive: true })
    writeFileSync(join(root, 'packages/host/src/extra.ts'), 'export interface Merged { right: string }\n')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}export type { Merged } from './extra.ts'\n`)
    const model = new WorkspaceAnalyzer({ root }).analyze()
    const declarations = model.faces.flatMap(face => face.graph.declarations)
    expect(JSON.stringify(declarations.map(d => `${d.kind}:${d.name}`))).toBe('PROBE-NAMES')
  })

  it('prints conflicting-merge declarations', () => {
    const root = mkdtempSync(join(import.meta.dirname, '.probe-conflict-'))
    cpSync(fixtureRoot, root, { recursive: true })
    writeFileSync(join(root, 'packages/host/src/extra.ts'), 'export interface Merged { right: number }\n')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}export type { Merged } from './extra.ts'\n`)
    const model = new WorkspaceAnalyzer({ root }).analyze()
    const declarations = model.faces.flatMap(face => face.graph.declarations)
    expect(JSON.stringify(declarations.map(d => `${d.kind}:${d.name}`))).toBe('PROBE-CONFLICT')
  })

  it('prints typeRoots external targets', () => {
    const root = mkdtempSync(join(import.meta.dirname, '.probe-typeroots-'))
    cpSync(fixtureRoot, root, { recursive: true })
    enableAmbientTypeRoots(root)
    const model = new WorkspaceAnalyzer({ root }).analyze()
    const targets = model.faces.flatMap(face => face.graph.nodes)
      .flatMap(node => node.kind === 'reference' ? [node.target] : [])
    expect(JSON.stringify(targets.filter(t => t.kind === 'external'))).toBe('PROBE-TYPEROOTS')
  })
})
