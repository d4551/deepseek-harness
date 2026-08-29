/**
 * Lexical Typert surface detection without a type-checker program.
 */

import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { SourceFile } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isClassDeclaration,
  isEnumDeclaration,
  isExportDeclaration,
  isImportDeclaration,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isPropertyDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import { typertMode, typertServiceTag, memberName } from './analyzer-docs.ts'
import { expressionName } from './analyzer-names.ts'
import { decoratorsOf } from './ts7-syntax.ts'

/**
 * Whether a source file declares a Typert or Cordis surface that should enter
 * the workspace inventory.
 * @param sourceFile - isolated parse of one package file.
 * @returns true when the file contributes services, events, or @typert roots.
 */
export function sourceFileHasSurface(sourceFile: SourceFile): boolean {
  for (const statement of sourceFile.statements) {
    if ((isClassDeclaration(statement)
      || isInterfaceDeclaration(statement)
      || isTypeAliasDeclaration(statement)
      || isEnumDeclaration(statement))
      && (typertMode(statement) !== undefined || typertServiceTag(statement) !== undefined)) return true
    if (isClassDeclaration(statement)) {
      for (const member of statement.members) {
        if (isPropertyDeclaration(member)
          && memberName(member.name) === 'typertRemote'
          && member.initializer !== undefined
          && isCallExpression(member.initializer)
          && expressionName(member.initializer.expression) === 'bindTypertRemote') return true
        for (const decorator of decoratorsOf(member)) {
          const expression = isCallExpression(decorator.expression)
            ? decorator.expression.expression
            : decorator.expression
          const name = expressionName(expression)
          if (name === 'Remote' || name === 'RemoteScope') return true
        }
      }
    }
    if (!isModuleDeclaration(statement)
      || !isStringLiteral(statement.name)
      || statement.name.text !== '@deepseek-ai/cordis'
      || statement.body === undefined
      || !isModuleBlock(statement.body)) continue
    if (statement.body.statements.some(member => isInterfaceDeclaration(member)
      && (member.name.text === 'Context' || member.name.text === 'Events')
      && member.members.length > 0)) return true
  }
  return false
}

/**
 * Relative import targets from one source file, resolved against disk.
 * @param sourceFile - isolated parse.
 * @param fromFile - absolute path of that file.
 * @returns existing in-package TypeScript files the module imports or re-exports.
 */
export function localImportTargets(sourceFile: SourceFile, fromFile: string): string[] {
  const targets: string[] = []
  for (const statement of sourceFile.statements) {
    let spec: string | undefined
    if ((isImportDeclaration(statement) || isExportDeclaration(statement))
      && statement.moduleSpecifier !== undefined
      && isStringLiteral(statement.moduleSpecifier)) {
      spec = statement.moduleSpecifier.text
    }
    if (spec === undefined || !spec.startsWith('.')) continue
    const resolved = resolve(dirname(fromFile), spec)
    for (const candidate of [
      resolved,
      `${resolved}.ts`,
      `${resolved}.tsx`,
      resolve(resolved, 'index.ts'),
      resolve(resolved, 'index.tsx'),
    ]) {
      if (existsSync(candidate)) {
        targets.push(candidate)
        break
      }
    }
  }
  return targets
}
