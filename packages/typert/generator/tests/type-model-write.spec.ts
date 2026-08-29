/**
 * WorkspaceAnalyzer write-mode, import, and diagnostic tests.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TypertAnalysisError } from '../src/analyzer-error.ts'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  addSameFacePackage,
  copyFixture,
  temporaryRoots,
} from './type-model-helpers.ts'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('WorkspaceAnalyzer write and import rules', { timeout: 60_000 }, () => {
  it('fails in check mode and writes inferred public annotations in write mode', () => {
    const root = copyFixture('typert-type-model-')
    const options = {
      root,
      hostConfig: 'tsconfig.write.json',
      clientConfig: 'missing.client.json',
      packages: ['@fixture/write'],
    } as const
    expect(() => new WorkspaceAnalyzer({ ...options, mode: 'check' }).analyze())
      .toThrow(TypertAnalysisError)
    const model = new WorkspaceAnalyzer({ ...options, mode: 'write' }).analyze()
    const source = readFileSync(join(root, 'packages/write/src/index.ts'), 'utf8')
    expect(source).toContain('value: number = 1')
    expect(source).toContain("echo(input: string = 'value'): string")
    expect(model.faces[0]?.packages[0]?.services[0]?.key).toBe('writable')
    const echo = model.faces[0]?.graph.declarations
      .flatMap(declaration => declaration.members)
      .find(member => member.name === 'echo')
    if (echo?.kind !== 'method') throw new Error('write fixture has no echo method')
    expect(echo.signature.parameters[0]?.initializer).toBe("'value'")
  })

  it('rejects relative imports across face boundaries', () => {
    const root = copyFixture('typert-relative-face-')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8')
      .replace("from '@fixture/host'", "from '../../host/src/index.ts'"))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      /crosses a package or face without an explicit import/,
    )
  })

  it('rejects package subpaths absent from package.json exports', () => {
    const root = copyFixture('typert-private-export-')
    writeFileSync(join(root, 'packages/host/src/private.ts'), 'export interface PrivateHost { readonly value: string }\n')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8')
      .replace(
        "import type { HostAgent, Payload } from '@fixture/host'",
        "import type { HostAgent, Payload } from '@fixture/host'\nimport type { PrivateHost } from '@fixture/host/private'",
      )
      .replace(
        'export class ClientBridge extends Service {',
        'export class ClientBridge extends Service {\n  leak(value: PrivateHost): void { void value }',
      ))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'cross-face reference PrivateHost is not exported by @fixture/host at ./private',
    )
  })

  it('rejects cross-face re-exports outside package.json exports', () => {
    const root = copyFixture('typert-private-reexport-')
    writeFileSync(join(root, 'packages/host/src/private.ts'), 'export interface PrivateHost { readonly value: string }\n')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, [readFileSync(sourcePath, 'utf8'), "export type { PrivateHost } from '@fixture/host/private'", ''].join('\n'))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'cross-face re-export PrivateHost is not exported by @fixture/host at ./private',
    )
  })

  it('rejects cross-face namespace re-exports until the model has a namespace target', () => {
    const root = copyFixture('typert-namespace-reexport-')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, [readFileSync(sourcePath, 'utf8'), "export type * as HostNamespace from '@fixture/host'", ''].join('\n'))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'cross-face namespace re-exports are not supported',
    )
  })

  it('records public symbols from explicit cross-face star re-exports', () => {
    const root = copyFixture('typert-star-reexport-')
    const sourcePath = join(root, 'packages/client', 'src/index.ts')
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8')
      .replace("export type { Box as ReexportedBox } from '@fixture/host'", "export type * from '@fixture/host'"))
    const model = new WorkspaceAnalyzer({ root }).analyze()
    expect(model.crossFaceLinks).toContainEqual({
      fromFace: 'client',
      fromPackage: '@fixture/client',
      toFace: 'host',
      toPackage: '@fixture/host',
      subpath: '.',
      name: 'Box',
    })
  })

  it('expands explicit same-face package exports through declaration targets', () => {
    const root = copyFixture('typert-same-face-')
    addSameFacePackage(root, '@fixture/host/models', 'Payload')
    const model = new WorkspaceAnalyzer({ root }).analyze()
    const host = model.faces.find(face => face.face === 'host')
    const payload = host?.graph.declarations.find(declaration => declaration.name === 'Payload')
    expect(host?.packages.map(packageModel => packageModel.name)).toContain('@fixture/consumer')
    expect(host?.graph.nodes.some(node => node.id.includes('packages/consumer/src/index.ts')
      && node.kind === 'reference'
      && node.name === 'Payload'
      && node.target.kind === 'declaration'
      && node.target.symbol === payload?.id)).toBe(true)
  })

  it('rejects same-face package imports outside package.json exports', () => {
    const root = copyFixture('typert-private-package-')
    writeFileSync(join(root, 'packages/host/src/private.ts'), 'export interface PrivateHost { readonly value: string }\n')
    addSameFacePackage(root, '@fixture/host/private', 'PrivateHost')
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'package reference PrivateHost is not exported by @fixture/host at ./private',
    )
  })

  it('rejects relative imports across same-face package boundaries', () => {
    const root = copyFixture('typert-relative-package-')
    addSameFacePackage(root, '@fixture/host/models', 'Payload')
    const sourcePath = join(root, 'packages/consumer/src/index.ts')
    writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8').replace("'@fixture/host/models'", "'../../host/src/models.ts'"))
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'reference to Payload crosses a package without an explicit package import',
    )
  })

  it('rejects TypeScript projects with source diagnostics before modeling them', () => {
    const root = copyFixture('typert-invalid-project-')
    const sourcePath = join(root, 'packages/host/src/index.ts')
    writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\nconst invalidFixture: string = 1\n`)
    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      /packages\/host\/src\/index\.ts:\d+:\d+: TypeScript TS2322/,
    )
  })
})
