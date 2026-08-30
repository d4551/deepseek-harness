/**
 * Shared type-model case bodies for same-face packages and source
 * diagnostics. Registered by type-model.spec.ts; the split
 * type-model-*.spec.ts files register the same functions.
 */

import { expect } from 'vitest'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import {
  addSameFacePackage,
  copyFixture,
  readObject,
  writeObject,
} from './type-model-helpers.ts'

export function expandsSameFacePackageExports(): void {
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
}

export function resolvesSameFaceReExportsToOwner(): void {
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
  const compilerOptions = Reflect.get(base, 'compilerOptions')
  if (compilerOptions !== null && typeof compilerOptions === 'object' && !Array.isArray(compilerOptions)) {
    const paths = Reflect.get(compilerOptions, 'paths')
    if (paths !== null && typeof paths === 'object' && !Array.isArray(paths)) {
      Reflect.set(paths, '@fixture/barrel', ['./packages/barrel/src/index.ts'])
    }
  }
  writeObject(basePath, base)
  const aggregatePath = join(root, 'tsconfig.host.json')
  const aggregate = readObject(aggregatePath)
  const refs = Reflect.get(aggregate, 'references')
  if (Array.isArray(refs)) refs.push({ path: './packages/barrel' })
  writeObject(aggregatePath, aggregate)
  addSameFacePackage(root, '@fixture/barrel', 'Payload')
  const consumerConfigPath = join(root, 'packages/consumer/tsconfig.json')
  const consumerConfig = readObject(consumerConfigPath)
  const consumerRefs = Reflect.get(consumerConfig, 'references')
  if (Array.isArray(consumerRefs)) consumerRefs.push({ path: '../barrel' })
  writeObject(consumerConfigPath, consumerConfig)

  const model = new WorkspaceAnalyzer({ root }).analyze()
  const host = model.faces.find(face => face.face === 'host')
  const payload = host?.graph.declarations.find(declaration => declaration.name === 'Payload')
  expect(host?.graph.nodes.some(node => node.id.includes('packages/consumer/src/index.ts')
    && node.kind === 'reference'
    && node.name === 'Payload'
    && node.target.kind === 'declaration'
    && node.target.symbol === payload?.id)).toBe(true)
}

export function rejectsSameFaceImportsOutsideExports(): void {
  const root = copyFixture('typert-private-package-')
  writeFileSync(join(root, 'packages/host/src/private.ts'), 'export interface PrivateHost { readonly value: string }\n')
  addSameFacePackage(root, '@fixture/host/private', 'PrivateHost')

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    'package reference PrivateHost is not exported by @fixture/host at ./private',
  )
}

export function rejectsRelativeImportsAcrossPackages(): void {
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
}

export function rejectsProjectsWithSourceDiagnostics(): void {
  const root = copyFixture('typert-invalid-project-')
  const sourcePath = join(root, 'packages/host/src/index.ts')
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\nconst invalidFixture: string = 1\n`)

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    /packages\/host\/src\/index\.ts:\d+:\d+: TypeScript TS2322/,
  )
}
