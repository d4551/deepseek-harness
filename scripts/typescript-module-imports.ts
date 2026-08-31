/**
 * Reject the TypeScript 6 (Strada) compiler API by parsing every import of the
 * `typescript` module rather than matching its text.
 *
 * TypeScript 7's `.` export is version metadata, not a compiler: the classic
 * `createProgram` / `sys` / `factory` surface is only reachable from
 * `typescript/unstable/*`. A grep over this cannot be made complete — the
 * receiver is an arbitrary alias, the clause may span lines, and the specifier
 * may carry a subpath — so the rule is expressed as an allow-list over parsed
 * import syntax: the compiler's own parser decides what an import is.
 * @module scripts/typescript-module-imports
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Node, SourceFile } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isExportDeclaration,
  isIdentifier,
  isImportDeclaration,
  isImportEqualsDeclaration,
  isPropertyAccessExpression,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { createSourceFile, parsePaths } from './ts7-session.ts'

/** The only named exports TypeScript 7's `.` entry actually provides. */
const VERSION_EXPORTS: readonly string[] = ['version', 'versionMajorMinor']

/** The only `typescript` subpath prefix that carries a compiler API. */
const LEGAL_SUBPATH_PREFIX = 'typescript/unstable/'

/** One rejected reference to the `typescript` module. */
export interface TypescriptImportViolation {
  /** Repository-relative path of the file holding the reference. */
  readonly file: string
  /** Module specifier as written. */
  readonly specifier: string
  /** Why the reference is rejected. */
  readonly reason: string
}

/**
 * Text of a node usable as a module specifier. A specifier may be written as a
 * plain string or as an untagged template, and both reach the resolver.
 * @param node - candidate specifier node.
 * @returns the literal text, or undefined when the node is not one.
 */
function specifierText(node: Node): string | undefined {
  if (isStringLiteral(node)) return node.text
  if (node.kind === SyntaxKind.NoSubstitutionTemplateLiteral) {
    const value: unknown = Reflect.get(node, 'text')
    return typeof value === 'string' ? value : undefined
  }
  return undefined
}

/**
 * Collapse `.` and `..` inside a specifier so a traversal cannot dress a
 * TypeScript 6 entry point up as an allowed subpath.
 */
function normalizeSpecifier(specifier: string): string {
  const parts: string[] = []
  for (const segment of specifier.split('/')) {
    if (segment === '.' || segment === '') continue
    if (segment === '..') { parts.pop(); continue }
    parts.push(segment)
  }
  return parts.join('/')
}

/** Whether a specifier names the `typescript` module or one of its subpaths. */
function isTypescriptSpecifier(specifier: string): boolean {
  const normalized = normalizeSpecifier(specifier)
  return normalized === 'typescript' || normalized.startsWith('typescript/')
}

/**
 * Classify one specifier reached through a form that binds no named clause —
 * `require()`, dynamic `import()`, or `import x = require()`.
 * @param specifier - module specifier as written.
 * @returns the rejection reason, or undefined when the reference is legal.
 */
function subpathReason(specifier: string): string | undefined {
  if (normalizeSpecifier(specifier).startsWith(LEGAL_SUBPATH_PREFIX)) return undefined
  if (specifier === 'typescript') {
    return "the '.' export is version metadata, not a compiler; import from 'typescript/unstable/*'"
  }
  return `'${specifier}' is a TypeScript 6 entry point; import from 'typescript/unstable/*'`
}

/**
 * Classify one static `import` or re-`export` declaration.
 * @param specifier - module specifier as written.
 * @param clause - the import clause, absent for a bare or re-export form.
 * @returns the rejection reason, or undefined when the reference is legal.
 */
function declarationReason(specifier: string, clause: Node | undefined): string | undefined {
  if (normalizeSpecifier(specifier).startsWith(LEGAL_SUBPATH_PREFIX)) return undefined
  if (specifier !== 'typescript') {
    return `'${specifier}' is a TypeScript 6 entry point; import from 'typescript/unstable/*'`
  }
  // Bare `import 'typescript'` and `export * from 'typescript'` bind nothing a
  // reader can check, so neither can be allowed through the version exception.
  if (clause === undefined) {
    return "only { version, versionMajorMinor } may come from 'typescript'"
  }
  // `NamedImports` and `NamedExports` are distinct kinds carrying the same
  // specifier shape; a re-export of the version metadata is as legal as an
  // import of it, so both are read through their elements.
  if (clause.kind !== SyntaxKind.NamedImports && clause.kind !== SyntaxKind.NamedExports) {
    return "only { version, versionMajorMinor } may come from 'typescript'"
  }
  const elements: unknown = Reflect.get(clause, 'elements')
  if (!Array.isArray(elements)) {
    return "only { version, versionMajorMinor } may come from 'typescript'"
  }
  const specifiers = elements as readonly {
    readonly propertyName?: { readonly text: string }
    readonly name: { readonly text: string }
  }[]
  const illegal = specifiers
    .map(element => element.propertyName?.text ?? element.name.text)
    .filter(name => !VERSION_EXPORTS.includes(name))
  if (illegal.length === 0) return undefined
  return `TypeScript 6 compiler API imported from 'typescript': ${illegal.sort().join(', ')}`
}

/** Walk one parsed file, collecting every rejected `typescript` reference. */
function collect(file: string, source: SourceFile, found: TypescriptImportViolation[]): void {
  const visit = (node: Node): void => {
    const importSpecifier = isImportDeclaration(node) ? specifierText(node.moduleSpecifier) : undefined
    if (isImportDeclaration(node) && importSpecifier !== undefined) {
      const specifier = importSpecifier
      if (isTypescriptSpecifier(specifier)) {
        // A default or namespace binding is neither, so `namedBindings` stays
        // undefined here and the clause check rejects it.
        const reason = declarationReason(
          specifier,
          node.importClause?.name === undefined ? node.importClause?.namedBindings : undefined,
        )
        if (reason !== undefined) found.push({ file, specifier, reason })
      }
    } else if (isExportDeclaration(node)
      && node.moduleSpecifier !== undefined && isStringLiteral(node.moduleSpecifier)) {
      const specifier = node.moduleSpecifier.text
      if (isTypescriptSpecifier(specifier)) {
        const reason = declarationReason(specifier, node.exportClause)
        if (reason !== undefined) found.push({ file, specifier, reason })
      }
    } else if (isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference
      if (!isCallExpression(reference) && 'expression' in reference) {
        const target = Reflect.get(reference, 'expression') as Node | undefined
        if (target !== undefined && isStringLiteral(target)) {
          const specifier = target.text
          const reason = isTypescriptSpecifier(specifier) ? subpathReason(specifier) : undefined
          if (reason !== undefined) found.push({ file, specifier, reason })
        }
      }
    } else if (isCallExpression(node)) {
      // Module loads take three shapes: the `import` keyword, a `require`
      // identifier or member (`require.resolve`), and a call returning a
      // loader — `createRequire(url)('typescript')`, the live CJS escape in an
      // ESM-only tree. Any other callee taking this string is using it as a
      // value: `'typescript'` is also an LSP languageId.
      const callee = node.expression
      const loads = callee.kind === SyntaxKind.ImportKeyword
        || (isIdentifier(callee) && callee.text === 'require')
        || (isPropertyAccessExpression(callee) && isIdentifier(callee.expression)
          && callee.expression.text === 'require')
        || isCallExpression(callee)
      const first = node.arguments[0]
      const specifier = first === undefined ? undefined : specifierText(first)
      if (loads && specifier !== undefined && isTypescriptSpecifier(specifier)) {
        const reason = subpathReason(specifier)
        if (reason !== undefined) found.push({ file, specifier, reason })
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
}

/**
 * Reject every TypeScript 6 compiler-API reference in the given sources.
 * @param files - repository-relative path plus source text; a live tree or an
 *   injected fixture.
 * @returns one entry per rejected reference, in file order.
 */
export function typescriptImportViolations(
  files: readonly { readonly file: string; readonly text: string }[],
): TypescriptImportViolation[] {
  const found: TypescriptImportViolation[] = []
  for (const { file, text } of files) {
    // Only files naming the module can hold a reference to it, and parsing is
    // the expensive half of this scan.
    if (!text.includes('typescript')) continue
    collect(file, createSourceFile(file, text), found)
  }
  return found
}

/**
 * Reject every TypeScript 6 compiler-API reference in the given on-disk files.
 *
 * One batched snapshot rather than a parse per file: the compiler session costs
 * a round trip per `updateSnapshot`, and the live scan covers thousands of
 * candidates. Only files quoting the module can name it, so the rest never
 * reach the parser at all.
 * @param root - repository root the paths are relative to.
 * @param files - repository-relative paths to scan.
 * @returns one entry per rejected reference.
 */
export function typescriptImportViolationsForPaths(
  root: string,
  files: readonly string[],
): TypescriptImportViolation[] {
  const candidates = files.filter((file) => {
    const path = resolve(root, file)
    // `git ls-files` reports a tracked file that the working tree no longer has;
    // there is no content to scan, and reading it would abort the whole gate.
    if (!existsSync(path)) return false
    // A reference has to quote its specifier, so an unquoted mention cannot be one.
    return /['"`]typescript/.test(readFileSync(path, 'utf8'))
  })
  if (candidates.length === 0) return []
  const parsed = parsePaths(candidates.map(file => resolve(root, file)))
  const found: TypescriptImportViolation[] = []
  for (const file of candidates) {
    const source = parsed.get(resolve(root, file))
    if (source === undefined) throw new Error(`typescript-module-imports: ${file} did not parse`)
    collect(file, source, found)
  }
  return found
}
