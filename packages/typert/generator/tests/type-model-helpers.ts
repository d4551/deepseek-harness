/**
 * Shared fixtures for Typert type-model tests.
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse, type ParseError } from 'jsonc-parser'
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
} satisfies Record<TypeNodeModel['kind'], true>

export const TYPE_TARGET_KINDS = {
  declaration: true,
  'type-parameter': true,
  'cross-face': true,
  external: true,
  standard: true,
} satisfies Record<TypeTargetModel['kind'], true>

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
} satisfies Record<KeywordTypeName, true>

export const TYPE_OPERATOR_NAMES = {
  keyof: true,
  readonly: true,
  unique: true,
} satisfies Record<TypeOperatorName, true>

export const DECLARATION_KINDS = {
  interface: true,
  class: true,
  alias: true,
  enum: true,
} satisfies Record<TypeDeclarationModel['kind'], true>

export const MEMBER_KINDS = {
  property: true,
  method: true,
  getter: true,
  setter: true,
  call: true,
  construct: true,
  index: true,
} satisfies Record<MemberModel['kind'], true>

export const fixtureRoot = resolve(import.meta.dirname, 'fixtures/type-model')
export const temporaryRoots: string[] = []

/** One JSON value as stored in fixture manifests, tsconfigs, and generated artifacts. */
export type JsonInput = boolean | number | string | object | null | undefined

/** A JSON object whose every member is a JSON value. */
export type JsonRecord = { [key: string]: JsonInput }

export function distinct(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

export function copyFixture(prefix: string): string {
  const root = mkdtempSync(join(import.meta.dirname, `.${prefix}`))
  temporaryRoots.push(root)
  cpSync(fixtureRoot, root, { recursive: true })
  return root
}

export function addAggregateReference(root: string, reference: string) {
  const aggregatePath = join(root, 'tsconfig.host.json')
  const aggregate = readObject(aggregatePath)
  const references = aggregate['references']
  if (Array.isArray(references)) references.push({ path: reference })
  writeObject(aggregatePath, aggregate)
}

/**
 * Write one package-shaped directory the aggregate graph must ignore.
 * @param root - fixture workspace root.
 * @param relative - directory to create under the fixture root.
 * @param withManifest - whether to write a nameless package.json.
 */
export function writeUnreachablePackage(root: string, relative: string, withManifest: boolean) {
  mkdirSync(join(root, relative), { recursive: true })
  writeFileSync(join(root, relative, 'tsconfig.json'), '{}\n')
  if (withManifest) writeFileSync(join(root, relative, 'package.json'), '{}\n')
}

export function readObject(path: string): JsonRecord {
  const errors: ParseError[] = []
  const value = parse(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true }) as JsonInput
  if (errors.length > 0) throw new Error(`${path} is not valid JSON`)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} is not a JSON object`)
  }
  return value as JsonRecord
}

export function writeObject(path: string, value: object) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

export function configureDualRuntimeClient(root: string, splitProjects: boolean) {
  const packageRoot = join(root, 'packages/client')
  const manifestPath = join(packageRoot, 'package.json')
  const manifest = readObject(manifestPath)
  manifest['dsh'] = { client: {} }
  const exportsField = manifest['exports']
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
  const writeProjectConfig = (name: string, value: object) => {
    writeObject(join(packageRoot, name), value)
  }
  writeProjectConfig('tsconfig.host.json', { ...project, files: ['src/index.ts'] })
  writeProjectConfig('tsconfig.client.json', { ...project, files: ['src/client.ts'] })
  writeProjectConfig('tsconfig.json', {
    files: [],
    references: [
      { path: './tsconfig.host.json' },
      { path: './tsconfig.client.json' },
    ],
  })
  addAggregateReference(root, './packages/client/tsconfig.host.json')
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
  addAggregateReference(root, './packages/consumer')
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
  addAggregateReference(root, './packages/explicit-service')
}

export function setCompilerOption(
  config: JsonRecord,
  key: string,
  value: boolean | string | readonly string[],
) {
  let options = config['compilerOptions']
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    options = {}
    config['compilerOptions'] = options
  }
  Reflect.set(options, key, value)
}

export function requiredObject(value: object, key: string): JsonRecord {
  const found = Reflect.get(value, key)
  if (found === null || typeof found !== 'object') {
    throw new Error(`generated module is missing object ${key}`)
  }
  return found as JsonRecord
}

export function generatedSuccess(schema: JsonRecord, input: JsonInput): boolean {
  const parseFn = schema['safeParse']
  if (typeof parseFn !== 'function') throw new Error('schema has no safeParse')
  const result = parseFn.call(schema, input) as JsonRecord
  if (result === null || typeof result !== 'object') {
    throw new Error('safeParse did not return an object')
  }
  return Boolean(result['success'])
}
