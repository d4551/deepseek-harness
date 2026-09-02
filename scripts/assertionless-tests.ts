/**
 * Detection of test cases that assert nothing.
 *
 * A case whose body contains no assertion passes whenever its setup does not
 * throw, so it reports success for code it never checked. Two forms are
 * rejected: a body with no assertion at all, and a body whose only assertion
 * compares a literal to itself (`expect(true).toBe(true)`), which holds no
 * matter what the code under test did.
 *
 * "Reaching here without throwing is the contract" is a real contract, and it
 * has a real spelling: `expect(() => subject()).not.toThrow()` states the
 * claim, and fails when the subject starts throwing. A bare call followed by a
 * self-comparison states nothing.
 */

import { resolve } from 'node:path'
import { SyntaxKind } from 'typescript/unstable/ast'
import type { Node, SourceFile } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isIdentifier,
  isPropertyAccessExpression,
  isStringLiteralLikeNode,
} from 'typescript/unstable/ast/is'
import { parsePath } from './ts7-session.ts'
import { uniqueRepoFiles } from './repo-files.ts'

/** One test case that checks nothing. */
export interface AssertionlessCase {
  /** Repository-relative path of the spec. */
  file: string
  /** 1-based line the case opens on. */
  line: number
  /** The case's title. */
  title: string
  /** Which form fired. */
  kind: 'no-assertion' | 'self-comparison'
}

const ROOT = resolve(import.meta.dirname, '..')

/** Case-declaring globals. `bench` and `describe` are not cases. */
const CASE_NAMES = new Set(['it', 'test', 'fit', 'xit'])

/** Identifiers whose presence in a body counts as an assertion. */
const ASSERTION_NAMES = new Set(['expect', 'expectTypeOf', 'assert', 'assertType', 'fail'])

/**
 * Whether an expression names a test case, including the modifier forms
 * (`it.only`, `it.skipIf(...)`, `it.each([...])`) the suites here use.
 * @param expression - the callee of a call expression.
 * @returns true when the call declares one case.
 */
function isCaseCallee(expression: Node): boolean {
  if (isIdentifier(expression)) return CASE_NAMES.has(expression.text)
  if (isPropertyAccessExpression(expression)) return isCaseCallee(expression.expression)
  if (isCallExpression(expression)) return isCaseCallee(expression.expression)
  return false
}

/**
 * Whether a node's subtree calls an assertion.
 * @param node - the case body.
 * @returns true when any assertion identifier is invoked inside it.
 */
function assertsSomething(node: Node): boolean {
  let found = false
  const visit = (child: Node): void => {
    if (found) return
    if (isIdentifier(child) && ASSERTION_NAMES.has(child.text)) {
      found = true
      return
    }
    // A helper named `assertX` / `expectX` carries the assertion for the case.
    if (isIdentifier(child) && /^(?:assert|expect)[A-Z]/.test(child.text)) {
      found = true
      return
    }
    child.forEachChild(visit)
  }
  node.forEachChild(visit)
  return found
}

/**
 * Whether every assertion in a body compares one literal to an equal literal.
 *
 * `expect(true).toBe(true)` and `expect(1).toBe(1)` hold for every possible
 * behavior of the subject, so a body containing only those checks nothing.
 * @param node - the case body.
 * @returns true when at least one assertion exists and all are self-comparisons.
 */
function onlySelfComparisons(node: Node): boolean {
  let total = 0
  let trivial = 0
  const visit = (child: Node): void => {
    if (isCallExpression(child) && isIdentifier(child.expression) && child.expression.text === 'expect') {
      total += 1
      if (isSelfComparison(child)) trivial += 1
    }
    child.forEachChild(visit)
  }
  node.forEachChild(visit)
  return total > 0 && total === trivial
}

/** Literal kinds whose text fully determines the value. */
const SELF_COMPARABLE = new Set<SyntaxKind>([
  SyntaxKind.TrueKeyword,
  SyntaxKind.FalseKeyword,
  SyntaxKind.NumericLiteral,
  SyntaxKind.StringLiteral,
  SyntaxKind.NullKeyword,
])

/**
 * Whether one `expect(x)` call is matched against a literal equal to `x`.
 * @param call - the `expect(...)` call expression.
 * @returns true when the actual and expected are the same literal.
 */
function isSelfComparison(call: Node): boolean {
  if (!isCallExpression(call)) return false
  const actual = call.arguments[0]
  if (actual === undefined || !SELF_COMPARABLE.has(actual.kind)) return false
  const parent = call.parent
  if (!isPropertyAccessExpression(parent)) return false
  const matcher = parent.parent
  if (!isCallExpression(matcher)) return false
  const expected = matcher.arguments[0]
  if (expected === undefined) return false
  return expected.kind === actual.kind && expected.getText() === actual.getText()
}

/**
 * Find every case in one parsed spec that checks nothing.
 * @param file - repository-relative path, used in findings.
 * @param source - the parsed spec.
 * @returns every finding, in source order.
 */
export function scanAssertionless(file: string, source: SourceFile): AssertionlessCase[] {
  const findings: AssertionlessCase[] = []
  const visit = (node: Node): void => {
    if (isCallExpression(node) && isCaseCallee(node.expression)) {
      const title = node.arguments[0]
      const body = node.arguments[1]
      if (title !== undefined && isStringLiteralLikeNode(title) && body !== undefined) {
        const kind = assertsSomething(body)
          ? (onlySelfComparisons(body) ? 'self-comparison' : undefined)
          : 'no-assertion'
        if (kind !== undefined) {
          findings.push({
            file,
            line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1,
            title: title.text,
            kind,
          })
        }
      }
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return findings
}

/**
 * Load every tracked spec the rule applies to.
 * @param root - repository root.
 * @returns repository-relative path plus absolute path.
 */
export function specFiles(root: string = ROOT): { file: string; abs: string }[] {
  const patterns = [
    'packages/**/tests/**/*.spec.ts',
    'packages/**/tests/**/*.spec.tsx',
    'scripts/**/*.spec.ts',
    'apps/**/tests/**/*.spec.ts',
  ]
  return uniqueRepoFiles(root, patterns, path => path.includes('/node_modules/') || path.startsWith('vendor/'))
    .map(({ abs }) => ({ file: abs.slice(root.length + 1).split('\\').join('/'), abs }))
}

/**
 * Scan the live tree.
 * @param root - repository root.
 * @returns every case that checks nothing.
 */
export function auditAssertionless(root: string = ROOT): AssertionlessCase[] {
  return specFiles(root).flatMap(({ file, abs }) => scanAssertionless(file, parsePath(abs)))
}
