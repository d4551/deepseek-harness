/**
 * WorkspaceAnalyzer cross-face and same-face import resolution tests.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  addAggregateReference,
  addSameFacePackage,
  copyFixture,
  readObject,
  requiredObject,
  temporaryRoots,
  writeObject,
} from './type-model-helpers.ts'
import { rmSync } from 'node:fs'

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function editClientSource(root: string, transform: (source: string) => string) {
  const sourcePath = join(root, 'packages/client', 'src/index.ts')
  writeFileSync(sourcePath, transform(readFileSync(sourcePath, 'utf8')))
}

function expectAnalysisError(root: string, message: string | RegExp) {
  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(message)
}

function analyzeWorkspace(root: string) {
  return new WorkspaceAnalyzer({ root }).analyze()
}

function writePrivateHost(root: string) {
  writeFileSync(
    join(root, 'packages/host/src/private.ts'),
    'export interface PrivateHost { readonly value: string }\n',
  )
}

describe('WorkspaceAnalyzer imports', { timeout: 60_000 }, () => {
  it('rejects relative imports across face boundaries', () => {
    const root = copyFixture('typert-relative-face-')
    editClientSource(root, source => source.replace("from '@fixture/host'", "from '../../host/src/index.ts'"))

    expectAnalysisError(root, /crosses a package or face without an explicit import/)
  })

  it('rejects package subpaths absent from package.json exports', () => {
    const root = copyFixture('typert-private-export-')
    writePrivateHost(root)
    editClientSource(root, source => source
      .replace(
        "import type { HostAgent, Payload } from '@fixture/host'",
        "import type { HostAgent, Payload } from '@fixture/host'\nimport type { PrivateHost } from '@fixture/host/private'",
      )
      .replace(
        'export class ClientBridge extends Service {',
        'export class ClientBridge extends Service {\n  leak(value: PrivateHost): void { value }',
      ))

    expectAnalysisError(root, 'cross-face reference PrivateHost is not exported by @fixture/host at ./private')
  })

  it('rejects cross-face re-exports outside package.json exports', () => {
    const root = copyFixture('typert-private-reexport-')
    writePrivateHost(root)
    editClientSource(root, source => [
      source,
      "export type { PrivateHost } from '@fixture/host/private'",
      '',
    ].join('\n'))

    expectAnalysisError(root, 'cross-face re-export PrivateHost is not exported by @fixture/host at ./private')
  })

  it('rejects cross-face namespace re-exports until the model has a namespace target', () => {
    const root = copyFixture('typert-namespace-reexport-')
    editClientSource(root, source => [
      source,
      "export type * as HostNamespace from '@fixture/host'",
      '',
    ].join('\n'))

    expectAnalysisError(root, 'cross-face namespace re-exports are not supported')
  })

  it('ignores cross-face namespace exports that are not package exports', () => {
    const root = copyFixture('typert-private-namespace-reexport-')
    writeFileSync(
      join(root, 'packages/client', 'src/internal.ts'),
      "export type * as HiddenHostNamespace from '@fixture/host'\n",
    )
    editClientSource(root, source => [
      "import './internal.ts'",
      source,
      '',
    ].join('\n'))

    expect(analyzeWorkspace(root).faces
      .find(face => face.face === 'client')?.packages[0]?.services.map(service => service.key))
      .toContain('clientBridge')
  })

  it('records public symbols from explicit cross-face star re-exports', () => {
    const root = copyFixture('typert-star-reexport-')
    editClientSource(root, source => source
      .replace("export type { Box as ReexportedBox } from '@fixture/host'", "export type * from '@fixture/host'"))

    const model = analyzeWorkspace(root)
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

    const model = analyzeWorkspace(root)
    const host = model.faces.find(face => face.face === 'host')
    const payload = host?.graph.declarations.find(declaration => declaration.name === 'Payload')
    expect(host?.packages.map(packageModel => packageModel.name)).toContain('@fixture/consumer')
    expect(host?.graph.nodes.some(node => node.id.includes('packages/consumer/src/index.ts')
      && node.kind === 'reference'
      && node.name === 'Payload'
      && node.target.kind === 'declaration'
      && node.target.symbol === payload?.id)).toBe(true)
  })

  it('resolves explicit same-face package re-exports to their declaration owner', () => {
    const root = copyFixture('typert-same-face-reexport-')
    const packageRoot = join(root, 'packages/barrel')
    mkdirSync(join(packageRoot, 'src'), { recursive: true })
    writeObject(join(packageRoot, 'package.json'), {
      name: '@fixture/barrel',
      private: true,
      type: 'module',
      exports: {
        '.': {
          types: './lib/types/index.d.ts',
          default: './lib/index.js',
        },
      },
    })
    writeObject(join(packageRoot, 'tsconfig.json'), {
      extends: '../../tsconfig.base.json',
      compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
      include: ['src'],
      references: [{ path: '../host' }],
    })
    writeFileSync(
      join(packageRoot, 'src/index.ts'),
      "export type { Payload } from '@fixture/host/models'\n",
    )
    const basePath = join(root, 'tsconfig.base.json')
    const base = readObject(basePath)
    const paths = requiredObject(requiredObject(base, 'compilerOptions'), 'paths')
    Reflect.set(paths, '@fixture/barrel', ['./packages/barrel/src/index.ts'])
    writeObject(basePath, base)
    addAggregateReference(root, './packages/barrel')
    addSameFacePackage(root, '@fixture/barrel', 'Payload')
    const consumerConfigPath = join(root, 'packages/consumer/tsconfig.json')
    const consumerConfig = readObject(consumerConfigPath)
    const consumerReferences = Reflect.get(consumerConfig, 'references')
    if (Array.isArray(consumerReferences)) consumerReferences.push({ path: '../barrel' })
    writeObject(consumerConfigPath, consumerConfig)

    const model = analyzeWorkspace(root)
    const host = model.faces.find(face => face.face === 'host')
    const payload = host?.graph.declarations.find(declaration => declaration.name === 'Payload')
    expect(host?.graph.nodes.some(node => node.id.includes('packages/consumer/src/index.ts')
      && node.kind === 'reference'
      && node.name === 'Payload'
      && node.target.kind === 'declaration'
      && node.target.symbol === payload?.id)).toBe(true)
  })

  it('rejects same-face package imports outside package.json exports', () => {
    const root = copyFixture('typert-private-package-')
    writePrivateHost(root)
    addSameFacePackage(root, '@fixture/host/private', 'PrivateHost')

    expectAnalysisError(root, 'package reference PrivateHost is not exported by @fixture/host at ./private')
  })

  it('rejects relative imports across same-face package boundaries', () => {
    const root = copyFixture('typert-relative-package-')
    addSameFacePackage(root, '@fixture/host/models', 'Payload')
    const sourcePath = join(root, 'packages/consumer/src/index.ts')
    writeFileSync(
      sourcePath,
      readFileSync(sourcePath, 'utf8')
        .replace("'@fixture/host/models'", "'../../host/src/models.ts'"),
    )

    expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
      'reference to Payload crosses a package without an explicit package import',
    )
  })
})
