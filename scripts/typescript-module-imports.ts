/** Enforce TypeScript package entry points by walking parsed module loads. */
import { readFileSync } from 'node:fs'
import { extname, resolve } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'
import traverse from '@babel/traverse'
import * as t from '@babel/types'

const VERSION_EXPORTS: readonly string[] = ['version', 'versionMajorMinor']
const LEGAL_SUBPATH_PREFIX = 'typescript/unstable/'

/** One rejected reference to the TypeScript package. */
export interface TypescriptImportViolation {
  /** Repository-relative source path. */
  readonly file: string
  /** Decoded module specifier. */
  readonly specifier: string
  /** Entry-point contract that the reference violates. */
  readonly reason: string
}

function specifierText(node: t.Node | undefined): string | undefined {
  if (t.isStringLiteral(node)) return node.value
  if (t.isTemplateLiteral(node) && node.expressions.length === 0) {
    return node.quasis[0]?.value.cooked ?? undefined
  }
  return undefined
}

function normalizeSpecifier(specifier: string): string {
  const parts: string[] = []
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') { parts.pop(); continue }
    parts.push(segment)
  }
  return parts.join('/')
}

function reasonFor(specifier: string, names: readonly string[] | undefined): string | undefined {
  const normalized = normalizeSpecifier(specifier)
  if (normalized !== 'typescript' && !normalized.startsWith('typescript/')) return undefined
  if (normalized.startsWith(LEGAL_SUBPATH_PREFIX)) return undefined
  if (specifier !== 'typescript') {
    return `'${specifier}' is a TypeScript 6 entry point; import from 'typescript/unstable/*'`
  }
  if (names === undefined || names.length === 0) {
    return "only { version, versionMajorMinor } may come from 'typescript'"
  }
  const illegal = names.filter(name => !VERSION_EXPORTS.includes(name))
  if (illegal.length === 0) return undefined
  return `TypeScript 6 compiler API imported from 'typescript': ${illegal.sort().join(', ')}`
}

function declarationNames(
  specifiers: readonly (t.ImportDeclaration['specifiers'][number] | t.ExportNamedDeclaration['specifiers'][number])[],
): string[] | undefined {
  const names: string[] = []
  for (const specifier of specifiers) {
    if (t.isImportSpecifier(specifier)) {
      names.push(t.isIdentifier(specifier.imported) ? specifier.imported.name : specifier.imported.value)
    } else if (t.isExportSpecifier(specifier)) {
      names.push(specifier.local.name)
    } else {
      return undefined
    }
  }
  return names
}

function collect(file: string, text: string): TypescriptImportViolation[] {
  const extension = extname(file)
  const plugins: ParserPlugin[] = ['decorators']
  if (/\.[cm]?tsx?$/.test(extension)) plugins.push('typescript')
  if (extension === '.tsx' || extension === '.jsx') plugins.push('jsx')
  const source = parse(text, { sourceFilename: file, sourceType: 'unambiguous', plugins })
  const found: TypescriptImportViolation[] = []
  function record(node: t.Node | undefined, names?: readonly string[]): void {
    const specifier = specifierText(node)
    if (specifier === undefined) return
    const reason = reasonFor(specifier, names)
    if (reason !== undefined) found.push({ file, specifier, reason })
  }
  function call(node: t.CallExpression | t.OptionalCallExpression): void {
    const callee = node.callee
    const loads = t.isIdentifier(callee, { name: 'require' })
      || ((t.isMemberExpression(callee) || t.isOptionalMemberExpression(callee))
        && t.isIdentifier(callee.object, { name: 'require' }))
      || t.isCallExpression(callee)
    if (loads) record(node.arguments[0])
  }
  traverse(source, {
    ImportDeclaration({ node }) { record(node.source, declarationNames(node.specifiers)) },
    ExportNamedDeclaration({ node }) {
      if (node.source !== null) record(node.source, declarationNames(node.specifiers))
    },
    ExportAllDeclaration({ node }) { record(node.source) },
    ImportExpression({ node }) { record(node.source) },
    TSImportEqualsDeclaration({ node }) {
      if (t.isTSExternalModuleReference(node.moduleReference)) record(node.moduleReference.expression)
    },
    TSImportType({ node }) { record(node.source) },
    CallExpression({ node }) { call(node) },
    OptionalCallExpression({ node }) { call(node) },
  })
  return found
}

/**
 * Inspect each source for disallowed TypeScript entry points.
 * @param files - source paths and complete contents.
 * @returns rejected references in source order; malformed syntax throws.
 */
export function typescriptImportViolations(
  files: readonly { readonly file: string; readonly text: string }[],
): TypescriptImportViolation[] {
  return files.flatMap(({ file, text }) => collect(file, text))
}

/**
 * Inspect every supplied on-disk source, including escaped module strings.
 * @param root - directory anchoring relative file paths.
 * @param files - source paths to inspect.
 * @returns rejected references; unreadable files and malformed syntax throw.
 */
export function typescriptImportViolationsForPaths(
  root: string,
  files: readonly string[],
): TypescriptImportViolation[] {
  return files.flatMap(file => collect(file, readFileSync(resolve(root, file), 'utf8')))
}
