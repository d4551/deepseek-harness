/**
 * Shared fixtures for Typert type-model tests.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import type {
  KeywordTypeName,
  MemberModel,
  TypeDeclarationModel,
  TypeNodeModel,
  TypeOperatorName,
  TypeTargetModel,
} from '../src/model.ts'

export const TYPE_NODE_KINDS = {
  keyword: true,
  literal: true,
  parenthesized: true,
  reference: true,
  union: true,
  intersection: true,
  array: true,
  tuple: true,
  object: true,
  function: true,
  constructor: true,
  'indexed-access': true,
  operator: true,
  conditional: true,
  infer: true,
  mapped: true,
  'template-literal': true,
  'type-query': true,
  'import-type': true,
  predicate: true,
  this: true,
} as const satisfies Record<TypeNodeModel['kind'], true>

export const TYPE_TARGET_KINDS = {
  declaration: true,
  'type-parameter': true,
  'cross-face': true,
  external: true,
  standard: true,
} as const satisfies Record<TypeTargetModel['kind'], true>

export const KEYWORD_TYPE_NAMES = {
  any: true,
  bigint: true,
  boolean: true,
  never: true,
  number: true,
  object: true,
  string: true,
  symbol: true,
  undefined: true,
  unknown: true,
  void: true,
} as const satisfies Record<KeywordTypeName, true>

export const TYPE_OPERATOR_NAMES = {
  keyof: true,
  readonly: true,
  unique: true,
} as const satisfies Record<TypeOperatorName, true>

export const DECLARATION_KINDS = {
  interface: true,
  class: true,
  alias: true,
  enum: true,
} as const satisfies Record<TypeDeclarationModel['kind'], true>

export const MEMBER_KINDS = {
  property: true,
  method: true,
  getter: true,
  setter: true,
  call: true,
  construct: true,
  index: true,
} as const satisfies Record<MemberModel['kind'], true>

export const fixtureRoot = resolve(import.meta.dirname, 'fixtures/type-model')
export const temporaryRoots: string[] = []

export function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

export function copyFixture(prefix: string): string {
  const root = mkdtempSync(join(import.meta.dirname, `.${prefix}`))
  temporaryRoots.push(root)
  cpSync(fixtureRoot, root, { recursive: true })
  return root
}

export function readObject(path: string): object {
  const value = parseJsonc(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return value
}

export function writeObject(path: string, value: object) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function configureDualRuntimeClient(root: string, splitProjects: boolean) {
  const packageRoot = join(root, 'packages/client')
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = readObject(manifestPath)
  Reflect.set(manifest, 'dsh', { client: {} })
  const exportsField = Reflect.get(manifest, 'exports')
  if (exportsField !== null && typeof exportsField === 'object' && !Array.isArray(exportsField)) {
    Reflect.set(exportsField, './client', {
      types: './lib/types/client.d.ts',
      default: './lib/client.js',
    })
  }
  writeObject(manifestPath, manifest)
  writeFileSync(join(packageRoot, 'src/client.ts'), [
    "import { Service } from '@deepseek-ai/cordis'",
    'export interface ClientOnlyMarker { readonly client: true }',
    'export class BrowserBridge extends Service {}',
    "declare module '@deepseek-ai/cordis' { interface Context { browserBridge: BrowserBridge } }",
    '',
  ].join('\n'))
  const indexPath = join(packageRoot, 'src/index.ts')
  writeFileSync(indexPath, `${readFileSync(indexPath, 'utf8')}\nexport interface HostOnlyMarker { readonly host: true }\n`)
  if (!splitProjects) return
  const project = readObject(join(packageRoot, 'tsconfig.json'))
  Reflect.deleteProperty(project, 'include')
  writeObject(join(packageRoot, 'tsconfig.host.json'), { ...project, files: ['src/index.ts'] })
  writeObject(join(packageRoot, 'tsconfig.client.json'), { ...project, files: ['src/client.ts'] })
  writeObject(join(packageRoot, 'tsconfig.json'), {
    files: [],
    references: [
      { path: './tsconfig.host.json' },
      { path: './tsconfig.client.json' },
    ],
  })
  const hostAggregatePath = join(root, 'tsconfig.host.json')
  const hostAggregate = readObject(hostAggregatePath)
  const hostRefs = Reflect.get(hostAggregate, 'references')
  if (Array.isArray(hostRefs)) hostRefs.push({ path: './packages/client/tsconfig.host.json' })
  writeObject(hostAggregatePath, hostAggregate)
  const clientAggregatePath = join(root, 'tsconfig.client.json')
  writeObject(clientAggregatePath, {
    ...readObject(clientAggregatePath),
    references: [{ path: './packages/client/tsconfig.client.json' }],
  })
}

export function addSameFacePackage(root: string, specifier: string, importedName: string) {
  const packageRoot = join(root, 'packages/consumer')
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  writeObject(join(packageRoot, 'package.json'), {
    name: '@fixture/consumer',
    private: true,
    type: 'module',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
  })
  writeObject(join(packageRoot, 'tsconfig.json'), {
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
    include: ['src'],
    references: [{ path: '../host' }],
  })
  writeFileSync(join(packageRoot, 'src/index.ts'), [
    `import type { ${importedName} } from '${specifier}'`,
    '/** @typert schema */',
    `export interface ConsumerSchema { readonly value: ${importedName} }`,
    '',
  ].join('\n'))
  const aggregatePath = join(root, 'tsconfig.host.json')
  const aggregate = readObject(aggregatePath)
  const refs = Reflect.get(aggregate, 'references')
  if (Array.isArray(refs)) refs.push({ path: './packages/consumer' })
  writeObject(aggregatePath, aggregate)
}

export function addExplicitServicePackage(root: string, annotation: string, withProtocol = false) {
  const packageRoot = join(root, 'packages/explicit-service')
  mkdirSync(join(packageRoot, 'src'), { recursive: true })
  writeObject(join(packageRoot, 'package.json'), {
    name: '@fixture/explicit-service',
    private: true,
    type: 'module',
    exports: { '.': { types: './lib/types/index.d.ts', default: './lib/index.js' } },
  })
  writeObject(join(packageRoot, 'tsconfig.json'), {
    extends: '../../tsconfig.base.json',
    compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
    include: ['src'],
  })
  if (withProtocol) {
    writeFileSync(join(packageRoot, 'src/types.ts'), [
      '/** Public detached Service protocol. */',
      'export interface DetachedProtocol {',
      '  /** Report protocol readiness. */',
      '  ready(): boolean',
      '}',
      "declare module '@deepseek-ai/cordis' {",
      '  interface Context { detached: DetachedProtocol }',
      '}',
      '',
    ].join('\n'))
  }
  writeFileSync(join(packageRoot, 'src/index.ts'), [
    "import { Service } from '@deepseek-ai/cordis'",
    ...(withProtocol ? ["export type { DetachedProtocol } from './types.ts'"] : []),
    '/**',
    ' * Service implementation discovered independently of its protocol package.',
    ` * @typert ${annotation}`,
    ' */',
    'export class DetachedService extends Service {',
    '  /** Report readiness. */',
    '  ready(): boolean { return true }',
    '}',
    '',
  ].join('\n'))
  const aggregatePath = join(root, 'tsconfig.host.json')
  const aggregate = readObject(aggregatePath)
  const refs = Reflect.get(aggregate, 'references')
  if (Array.isArray(refs)) refs.push({ path: './packages/explicit-service' })
  writeObject(aggregatePath, aggregate)
}
