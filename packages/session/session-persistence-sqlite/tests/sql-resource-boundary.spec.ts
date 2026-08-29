import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import type { Expression, Node, SourceFile } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isAwaitExpression,
  isBinaryExpression,
  isCallExpression,
  isClassExpression,
  isIdentifier,
  isIfStatement,
  isImportDeclaration,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isReturnStatement,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { describe, expect, it } from 'vitest'
import { closeCompiler, createSourceFile } from '../../../../scripts/ts7-session.ts'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const SQL_LITERAL = /^\s*(?:ALTER|ATTACH|BEGIN|COMMIT|CREATE|DELETE|DETACH|DROP|INSERT|PRAGMA|REINDEX|RELEASE|ROLLBACK|SAVEPOINT|SELECT|UPDATE|VACUUM|WITH)\s/iu // eslint-disable-line @stylistic/max-len

async function filesUnder(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  return (await Promise.all(entries.map(async entry => entry.isDirectory()
    ? filesUnder(`${path}/${entry.name}`)
    : [`${path}/${entry.name}`]))).flat()
}

function sqlLiteralText(node: Node): string | undefined {
  if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) return node.text
  if (node.kind === SyntaxKind.TemplateHead && 'text' in node && typeof node.text === 'string') {
    return node.text
  }
  return undefined
}

function isOwnedSqlSource(node: Expression | undefined, source: SourceFile): boolean {
  if (node === undefined) return false
  if (isCallExpression(node)
    && isIdentifier(node.expression)
    && (node.expression.text === 'sql' || node.expression.text === 'testSql')) return true
  if (!isIdentifier(node) || node.text !== 'source') return false
  const call = node.parent
  if (!isCallExpression(call)
    || call.arguments.length !== 1
    || call.arguments[0] !== node
    || !isPropertyAccessExpression(call.expression)
    || call.expression.expression.kind !== SyntaxKind.SuperKeyword
    || call.expression.name.text !== 'prepare') return false
  let method: Node | undefined = node.parent
  while (method !== undefined && !isMethodDeclaration(method)) method = method.parent
  if (method === undefined
    || method.name.getText(source) !== 'prepare'
    || method.parameters.length !== 1
    || method.parameters[0]?.name.getText(source) !== 'source') return false
  let classNode: Node | undefined = method.parent
  while (classNode !== undefined && !isClassExpression(classNode)) classNode = classNode.parent
  if (classNode === undefined || classNode.name?.text !== 'JournalFailureDatabase') return false
  const guard = method.body?.statements[0]
  if (guard === undefined
    || !isIfStatement(guard)
    || !isBinaryExpression(guard.expression)
    || guard.expression.operatorToken.kind !== SyntaxKind.ExclamationEqualsEqualsToken
    || guard.expression.left.getText(source) !== 'source'
    || guard.expression.right.getText(source) !== "sql('journal-mode-wal')") return false
  return isReturnStatement(guard.thenStatement)
    && guard.thenStatement.expression === call
}

describe('SQLite SQL resource boundary', () => {
  it('keeps statements and query assembly out of TypeScript files', async () => {
    const files = (await Promise.all([
      filesUnder(`${PACKAGE_ROOT}/src`),
      filesUnder(`${PACKAGE_ROOT}/tests`),
    ])).flat().filter(path => path.endsWith('.ts'))
    const violations: string[] = []
    for (const path of files) {
      const source = createSourceFile(path, await readFile(path, 'utf8'))
      const usesNodeSqlite = source.statements.some(statement => isImportDeclaration(statement)
        && isStringLiteral(statement.moduleSpecifier)
        && statement.moduleSpecifier.text === 'node:sqlite')
      const visit = (node: Node): void => {
        const literal = sqlLiteralText(node)
        if (literal !== undefined && SQL_LITERAL.test(literal)) {
          violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: SQL literal`)
        }
        // Awaited prepare() is SessionPersistence; DatabaseSync.prepare() is synchronous.
        if (usesNodeSqlite
          && isCallExpression(node)
          && isPropertyAccessExpression(node.expression)
          && (node.expression.name.text === 'exec'
            || (node.expression.name.text === 'prepare' && !isAwaitExpression(node.parent)))) {
          const argument = node.arguments[0]
          if (!isOwnedSqlSource(argument, source)) {
            violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: unowned query source`)
          }
        }
        node.forEachChild(visit)
      }
      visit(source)
    }
    closeCompiler()
    expect(violations).toEqual([])
  })

  it('keeps resource text static instead of interpolated', async () => {
    const files = (await Promise.all([
      filesUnder(`${PACKAGE_ROOT}/resources/sql`),
      filesUnder(`${PACKAGE_ROOT}/tests/resources/sql`),
    ])).flat()
    for (const path of files) {
      expect(path.endsWith('.sql')).toBe(true)
      expect(await readFile(path, 'utf8')).not.toContain('${')
    }
  })
})
