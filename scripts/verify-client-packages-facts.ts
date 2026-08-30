/**
 * Source-plane facts for {@link ./verify-client-packages.ts}: manifests,
 * static-linked roster, and TypeScript 7 client-face uses.
 */

import { globSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Expression, SourceFile } from 'typescript/unstable/ast'
import {
  isArrayLiteralExpression,
  isAsExpression,
  isIdentifier,
  isParenthesizedExpression,
  isSatisfiesExpression,
  isStringLiteral,
  isVariableStatement,
} from 'typescript/unstable/ast/is'
import { parsePath, readConfigFile } from './ts7-session.ts'
import { TypeScriptProject } from './ts-project.ts'
import { collectParsedSourceFileUses } from './verify-client-packages-uses.ts'
import {
  CLIENT_MANIFEST_GLOB,
  CONFIG_GLOB,
  GATE,
  MANIFEST_GLOBS,
  PARSER_PRELOAD_SOURCE,
  PLATFORM_SOURCE,
  STATIC_PRESET_SOURCE,
  normalizePath,
  type ClientDeclaration,
  type ClientDeclarations,
  type ClientPackage,
  type ClientPackageFacts,
  type Manifest,
} from './verify-client-packages-model.ts'

interface StaticLinkedPreset {
  isStaticLinkedConfig?: (configs: readonly object[]) => boolean
}

interface TsdownConfigModule {
  default?: (input: { env: Record<string, string> }) => object[]
}

/** Read one JSON object file through the JSONC parser. */
export function readObjectFile(path: string): object {
  const result = readConfigFile(path)
  if (result.error !== undefined) throw new Error(GATE + ': ' + path + ': ' + result.error.messageText)
  const config = result.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(GATE + ': ' + path + ' is not a JSON object')
  }
  return config
}

function optionalString(record: object, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  const value: unknown = Reflect.get(record, key)
  return typeof value === 'string' ? value : undefined
}

function optionalStringRecord(record: object, key: string): Record<string, string> {
  if (!Object.hasOwn(record, key)) return {}
  const value: unknown = Reflect.get(record, key)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(value)) {
    if (typeof range === 'string') out[name] = range
  }
  return out
}

function toManifest(record: object): Manifest {
  const name = optionalString(record, 'name')
  return {
    ...name === undefined ? {} : { name },
    dependencies: optionalStringRecord(record, 'dependencies'),
    peerDependencies: optionalStringRecord(record, 'peerDependencies'),
    devDependencies: optionalStringRecord(record, 'devDependencies'),
  }
}

function stringList(
  value: unknown,
  packageName: string,
  manifestPath: string,
  field: string,
  malformed: string[],
): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    malformed.push(manifestPath + ': ' + packageName + ' dsh.client.' + field + ' must be a string array')
    return []
  }
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry === 'string') entries.push(entry)
  }
  return entries
}

function readDeclaration(
  root: string,
  manifestPath: string,
  malformed: string[],
): ClientDeclaration | undefined {
  const record = readObjectFile(resolve(root, manifestPath))
  const name = optionalString(record, 'name')
  if (name === undefined) return undefined
  const blank: ClientDeclaration = {
    name, manifest: manifestPath, dynamic: false, external: [], inject: [],
    runtimeSourceUses: {}, runtimeSourceSpecifiers: {},
  }
  if (!Object.hasOwn(record, 'dsh')) return blank
  const dsh: unknown = Reflect.get(record, 'dsh')
  if (dsh === undefined) return blank
  if (dsh === null || typeof dsh !== 'object' || Array.isArray(dsh) || !Object.hasOwn(dsh, 'client')) {
    return blank
  }
  const rawClient: unknown = Reflect.get(dsh, 'client')
  if (rawClient === undefined) return blank
  if (rawClient === null || typeof rawClient !== 'object' || Array.isArray(rawClient)) {
    malformed.push(manifestPath + ': ' + name + ' dsh.client must be an object')
    return blank
  }
  return {
    name,
    manifest: manifestPath,
    dynamic: true,
    external: stringList(Reflect.get(rawClient, 'external'), name, manifestPath, 'external', malformed),
    inject: stringList(Reflect.get(rawClient, 'inject'), name, manifestPath, 'inject', malformed),
    runtimeSourceUses: {},
    runtimeSourceSpecifiers: {},
  }
}

/**
 * Read browser-module declarations from workspace manifests.
 * @param root - Absolute repository root.
 * @returns Declarations and malformed dsh.client fields.
 */
export function readClientDeclarations(root: string): ClientDeclarations {
  const malformed: string[] = []
  const declarations = globSync(MANIFEST_GLOBS, { cwd: root })
    .map(normalizePath)
    .sort()
    .flatMap(path => readDeclaration(root, path, malformed) ?? [])
  return { declarations, malformed }
}

function unwrapExpression(expression: Expression): Expression {
  let current = expression
  while (isAsExpression(current) || isSatisfiesExpression(current) || isParenthesizedExpression(current)) {
    current = current.expression
  }
  return current
}

function readStringLiteralArray(root: string, sourcePath: string, name: string): string[] {
  const path = resolve(root, sourcePath)
  const source = parsePath(path)
  const constants = new Map<string, string>()
  for (const statement of source.statements) {
    if (!isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name) || declaration.initializer === undefined) continue
      const initializer = unwrapExpression(declaration.initializer)
      if (isStringLiteral(initializer)) constants.set(declaration.name.text, initializer.text)
    }
  }
  for (const statement of source.statements) {
    if (!isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!isIdentifier(declaration.name) || declaration.name.text !== name) continue
      const expression = declaration.initializer === undefined ? undefined : unwrapExpression(declaration.initializer)
      if (expression === undefined || !isArrayLiteralExpression(expression)) {
        throw new Error(GATE + ': ' + name + ' in ' + sourcePath + ' must be an array literal')
      }
      return expression.elements.map((element) => {
        const value = unwrapExpression(element)
        if (isStringLiteral(value)) return value.text
        if (isIdentifier(value)) {
          const constant = constants.get(value.text)
          if (constant !== undefined) return constant
        }
        throw new Error(GATE + ': ' + name + ' in ' + sourcePath + ' must contain only string constants')
      })
    }
  }
  throw new Error(GATE + ': ' + sourcePath + ' declares no ' + name)
}

async function readStaticLinkedRoster(root: string): Promise<Set<string>> {
  const presetUrl = pathToFileURL(resolve(import.meta.dirname, '..', STATIC_PRESET_SOURCE)).href
  const preset = await import(presetUrl) as StaticLinkedPreset
  if (typeof preset.isStaticLinkedConfig !== 'function') {
    throw new Error(GATE + ': ' + STATIC_PRESET_SOURCE + ' exports no isStaticLinkedConfig')
  }
  const predicate = preset.isStaticLinkedConfig
  const roster = new Set<string>()
  for (const configPath of globSync(CONFIG_GLOB, { cwd: root }).map(normalizePath).sort()) {
    const loaded = await import(pathToFileURL(resolve(root, configPath)).href) as TsdownConfigModule
    if (typeof loaded.default !== 'function') continue
    const configs = loaded.default({ env: { DSH_BUILD_FACE: 'client' } })
    if (!Array.isArray(configs) || !predicate(configs)) continue
    const manifest = toManifest(readObjectFile(resolve(root, configPath.replace(/tsdown\.config\.ts$/, 'package.json'))))
    if (typeof manifest.name === 'string') roster.add(manifest.name)
  }
  return roster
}

function recordUses(
  sourceFiles: readonly SourceFile[],
  project: TypeScriptProject,
  sourcePrefix: string,
  runtimeOnly: boolean,
  key: 'package' | 'specifier',
): Record<string, readonly string[]> {
  const collected = new Map<string, Set<string>>()
  for (const sourceFile of sourceFiles) {
    if (sourceFile.isDeclarationFile) continue
    const file = project.relativePath(sourceFile)
    if (!file.startsWith(sourcePrefix)) continue
    for (const name of collectParsedSourceFileUses(sourceFile, runtimeOnly, key)) {
      const locations = collected.get(name) ?? new Set<string>()
      locations.add(file)
      collected.set(name, locations)
    }
  }
  return Object.fromEntries(
    [...collected].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, locations]) => [name, [...locations].sort()]),
  )
}

/**
 * Collect manifests, static-linked roster, and client-face source uses.
 * @param root - repository root.
 * @returns facts the verifier and fixer consume.
 */
export async function readFacts(root: string): Promise<ClientPackageFacts> {
  const { declarations: bareDeclarations, malformed } = readClientDeclarations(root)
  const staticLinkedPackages = await readStaticLinkedRoster(root)
  const project = new TypeScriptProject(root, 'client')
  const sourceFiles = project.sourceFiles()
  const declarations = bareDeclarations.map((declaration): ClientDeclaration => {
    const sourcePrefix = dirname(declaration.manifest).split(sep).join('/') + '/src/'
    return {
      ...declaration,
      runtimeSourceUses: recordUses(sourceFiles, project, sourcePrefix, true, 'package'),
      runtimeSourceSpecifiers: recordUses(sourceFiles, project, sourcePrefix, true, 'specifier'),
    }
  })
  const byManifest = new Map(declarations.map(entry => [entry.manifest, entry]))
  const packages: ClientPackage[] = []

  for (const manifestPath of globSync(CLIENT_MANIFEST_GLOB, { cwd: root }).map(normalizePath).sort()) {
    const declaration = byManifest.get(manifestPath)
    if (declaration === undefined) throw new Error(GATE + ': no declaration facts for ' + manifestPath)
    const manifest = toManifest(readObjectFile(resolve(root, manifestPath)))
    if (typeof manifest.name !== 'string') throw new Error(GATE + ': ' + manifestPath + ' has no package name')
    const sourcePrefix = dirname(manifestPath).split(sep).join('/') + '/src/'
    packages.push({
      ...declaration,
      staticLinked: staticLinkedPackages.has(declaration.name),
      sourceUses: recordUses(sourceFiles, project, sourcePrefix, false, 'package'),
      runtimeSourceUses: recordUses(sourceFiles, project, sourcePrefix, true, 'package'),
      dependencies: manifest.dependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      devDependencies: manifest.devDependencies ?? {},
    })
  }

  const facts: ClientPackageFacts = {
    packages,
    declarations,
    staticLinkedPackages,
    platformModules: readStringLiteralArray(root, PLATFORM_SOURCE, 'PLATFORM_MODULES'),
    preloadedExternals: readStringLiteralArray(root, PLATFORM_SOURCE, 'PRELOADED_CLIENT_EXTERNALS'),
    parserPreloadIds: readStringLiteralArray(root, PARSER_PRELOAD_SOURCE, 'PARSER_PRELOAD_IDS'),
    malformed,
  }
  project.close()
  return facts
}
