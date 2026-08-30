/**
 * Shared type-model case bodies for write mode and cross-face import rules.
 * Registered by type-model.spec.ts; the split type-model-*.spec.ts files
 * register the same functions.
 */

import { expect } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TypertAnalysisError } from '../src/analyzer-error.ts'
import { WorkspaceAnalyzer } from '../src/analyzer-workspace.ts'
import { copyFixture } from './type-model-helpers.ts'

export function failsCheckModeAndWritesAnnotations(): void {
  const root = copyFixture('typert-type-model-')
  const options = {
    root,
    hostConfig: 'tsconfig.write.json',
    clientConfig: 'missing.client.json',
    packages: ['@fixture/write'],
  }

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
}

export function rejectsRelativeImportsAcrossFaces(): void {
  const root = copyFixture('typert-relative-face-')
  const sourcePath = join(root, 'packages/client', 'src/index.ts')
  writeFileSync(sourcePath, readFileSync(sourcePath, 'utf8')
    .replace("from '@fixture/host'", "from '../../host/src/index.ts'"))

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    /crosses a package or face without an explicit import/,
  )
}

export function rejectsSubpathsAbsentFromExports(): void {
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
      'export class ClientBridge extends Service {\n  leak(value: PrivateHost): boolean { return value.value.length > 0 }',
    ))

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    'cross-face reference PrivateHost is not exported by @fixture/host at ./private',
  )
}

export function rejectsCrossFaceReExportsOutsideExports(): void {
  const root = copyFixture('typert-private-reexport-')
  writeFileSync(join(root, 'packages/host/src/private.ts'), 'export interface PrivateHost { readonly value: string }\n')
  const sourcePath = join(root, 'packages/client', 'src/index.ts')
  writeFileSync(sourcePath, [readFileSync(sourcePath, 'utf8'), "export type { PrivateHost } from '@fixture/host/private'", ''].join('\n'))

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    'cross-face re-export PrivateHost is not exported by @fixture/host at ./private',
  )
}

export function rejectsCrossFaceNamespaceReExports(): void {
  const root = copyFixture('typert-namespace-reexport-')
  const sourcePath = join(root, 'packages/client', 'src/index.ts')
  writeFileSync(sourcePath, [readFileSync(sourcePath, 'utf8'), "export type * as HostNamespace from '@fixture/host'", ''].join('\n'))

  expect(() => new WorkspaceAnalyzer({ root }).analyze()).toThrow(
    'cross-face namespace re-exports are not supported',
  )
}

export function ignoresNonPackageNamespaceExports(): void {
  const root = copyFixture('typert-private-namespace-reexport-')
  writeFileSync(
    join(root, 'packages/client', 'src/internal.ts'),
    "export type * as HiddenHostNamespace from '@fixture/host'\n",
  )
  const sourcePath = join(root, 'packages/client', 'src/index.ts')
  writeFileSync(sourcePath, [
    "import './internal.ts'",
    readFileSync(sourcePath, 'utf8'),
  ].join('\n'))

  expect(new WorkspaceAnalyzer({ root }).analyze().faces
    .find(face => face.face === 'client')?.packages[0]?.services.map(service => service.key))
    .toContain('clientBridge')
}

export function recordsPublicSymbolsFromStarReExports(): void {
  const root = copyFixture('typert-star-reexport-')
  const sourcePath = join(root, 'packages/client', 'src/index.ts')
  writeFileSync(
    sourcePath,
    readFileSync(sourcePath, 'utf8')
      .replace("export type { Box as ReexportedBox } from '@fixture/host'", "export type * from '@fixture/host'"),
  )

  const model = new WorkspaceAnalyzer({ root }).analyze()
  expect(model.crossFaceLinks).toContainEqual({
    fromFace: 'client',
    fromPackage: '@fixture/client',
    toFace: 'host',
    toPackage: '@fixture/host',
    subpath: '.',
    name: 'Box',
  })
}
