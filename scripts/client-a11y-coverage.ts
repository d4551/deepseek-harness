/**
 * Whether a client UI spec actually holds the axe floor.
 *
 * The policy is that every `ui-*` package shipping TSX is audited by axe-core.
 * Reading the spec's text for the harness import and the two call names could
 * not tell an audit from a comment mentioning one: a spec whose only reference
 * to `auditSurface` sat inside a block comment satisfied the check, which is
 * the one thing a coverage gate exists to refuse. This reads the spec's syntax
 * tree instead, through the compiler the repository already compiles with.
 *
 * Three facts, all of which a comment has none of: the harness is imported by
 * name, `auditSurface` is called, and the result of `accessibilityFailures` is
 * an argument to `expect` — computed and dropped is not asserted.
 *
 * @module scripts/client-a11y-coverage
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { Node, SourceFile } from 'typescript/unstable/ast'
import { isCallExpression, isIdentifier, isImportDeclaration, isStringLiteral } from 'typescript/unstable/ast/is'
import { parsePaths } from './ts7-session.ts'

/** The package every audited spec imports its harness from. */
const A11Y_MODULE = '@deepseek-ai/dsh-client-a11y'
/** The call that runs one surface through axe. */
const AUDIT_CALL = 'auditSurface'
/** The call whose result an audited spec asserts on. */
const FAILURES_CALL = 'accessibilityFailures'
/** The assertion the failures call has to reach. */
const EXPECT_CALL = 'expect'

/** Every file under one directory, recursively. */
export function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}

/**
 * Walk every node under `node`, `node` included.
 *
 * Through the node's own `forEachChild`, the way the generators beside this
 * walk a tree: the free function of that name is not part of the TS7 AST
 * package's exports.
 */
function walk(node: Node, visit: (node: Node) => void): void {
  visit(node)
  node.forEachChild((child) => {
    walk(child, visit)
    return undefined
  })
}

/** The name a call expression invokes, when it invokes a plain identifier. */
function calleeName(node: Node): string | undefined {
  if (!isCallExpression(node)) return undefined
  return isIdentifier(node.expression) ? node.expression.text : undefined
}

/** Whether the spec imports both harness functions by name from the harness. */
function importsHarness(source: SourceFile): boolean {
  let named = new Set<string>()
  walk(source, (node) => {
    if (!isImportDeclaration(node)) return
    if (!isStringLiteral(node.moduleSpecifier) || node.moduleSpecifier.text !== A11Y_MODULE) return
    const bindings = node.importClause?.namedBindings
    if (bindings === undefined || !('elements' in bindings)) return
    for (const element of bindings.elements) named = named.add(element.name.text)
  })
  return named.has(AUDIT_CALL) && named.has(FAILURES_CALL)
}

/**
 * Whether one parsed spec holds the axe floor.
 *
 * @param source - the spec's syntax tree.
 * @returns true when the spec imports the harness, calls `auditSurface`, and
 * asserts on `accessibilityFailures`.
 */
export function specHoldsAxeFloor(source: SourceFile): boolean {
  if (!importsHarness(source)) return false
  // Collected rather than flagged: a boolean a closure assigns is still typed
  // by its initialiser, which the compiler then reads as constant.
  const found = new Set<string>()
  walk(source, (node) => {
    if (!isCallExpression(node)) return
    const called = calleeName(node)
    if (called === AUDIT_CALL) found.add(AUDIT_CALL)
    if (called !== EXPECT_CALL) return
    for (const argument of node.arguments) {
      if (calleeName(argument) === FAILURES_CALL) found.add(FAILURES_CALL)
    }
  })
  return found.has(AUDIT_CALL) && found.has(FAILURES_CALL)
}

/** Every `ui-*` package under `clientRoot` whose `src` ships TSX. */
export function uiPackagesWithTsx(clientRoot: string): string[] {
  return readdirSync(clientRoot)
    .filter((name) => {
      if (!name.startsWith('ui-')) return false
      const src = join(clientRoot, name, 'src')
      return existsSync(src) && filesUnder(src).some(path => path.endsWith('.tsx'))
    })
    .sort()
}

/**
 * The spec files of one package that could hold the floor.
 *
 * Prefiltered on the module name before anything is parsed, the way the Cordis
 * walkers prefilter: parsing every spec in 37 packages to find the handful that
 * import the harness costs more than the gate is worth.
 * @param clientRoot - `packages/client`.
 * @param name - the package directory name.
 * @returns candidate spec paths.
 */
export function auditCandidates(clientRoot: string, name: string): string[] {
  const tests = join(clientRoot, name, 'tests')
  if (!existsSync(tests)) return []
  return filesUnder(tests).filter(path => path.includes('.spec.') && readFileSync(path, 'utf8').includes(A11Y_MODULE))
}

/**
 * The `ui-*` packages that ship TSX and audit none of it.
 * @param clientRoot - `packages/client`.
 * @returns package names, sorted, empty when every one is audited.
 */
export function packagesMissingAudit(clientRoot: string): string[] {
  const candidates = new Map<string, string[]>()
  for (const name of uiPackagesWithTsx(clientRoot)) candidates.set(name, auditCandidates(clientRoot, name))
  const parsed = parsePaths([...candidates.values()].flat())
  const audited = (path: string): boolean => {
    const source = parsed.get(path)
    return source !== undefined && specHoldsAxeFloor(source)
  }
  return [...candidates].filter(([, paths]) => !paths.some(audited)).map(([name]) => name)
}
