/**
 * Source-declaration extraction for {@link ./verify-type-equiv.ts}.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  ClassElement, ConstructorDeclaration, GetAccessorDeclaration, InterfaceDeclaration, MethodDeclaration,
  Node, PropertyDeclaration, SetAccessorDeclaration, SourceFile,
} from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isClassStaticBlockDeclaration,
  isConstructorDeclaration,
  isEnumDeclaration,
  isGetAccessorDeclaration,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import { rawJsDoc } from './jsdoc.ts'
import { createSourceFile, parsePath } from './ts7-session.ts'

const root = resolve(import.meta.dirname, '..')

function stripExport(code: string): string {
  return code.replace(/^export\s+(default\s+)?/, '')
}

function loadSource(sourceRel: string): { text: string; sourceFile: SourceFile } {
  const abs = resolve(root, sourceRel)
  return { text: readFileSync(abs, 'utf8'), sourceFile: parsePath(abs) }
}

function withJSDoc(jsDoc: string, declaration: string): string {
  return jsDoc === '' ? declaration : `${jsDoc}\n${declaration}`
}

function parseSource(abs: string, text: string): SourceFile {
  return createSourceFile(abs, text)
}

function namedDeclarationName(stmt: Node): string | undefined {
  if (isInterfaceDeclaration(stmt) || isTypeAliasDeclaration(stmt)
    || isClassDeclaration(stmt) || isEnumDeclaration(stmt)) {
    return stmt.name?.text
  }
  return undefined
}

/** Parse the declared symbol name from a source-equivalence block body. */
export function blockSymbol(code: string): string | null {
  const sf = parseSource('type-equiv.ts', code)
  for (const stmt of sf.statements) {
    const name = namedDeclarationName(stmt)
    if (name !== undefined) return name
  }
  return null
}

/** Leading JSDoc attached to one declaration or member. */
export function sourceJSDoc(text: string, node: Node): string {
  return rawJsDoc(text, node)
}

/**
 * The declaration text of `symbol` in `sourceRel`, with `export` stripped.
 * @param sourceRel - repository-relative source path.
 * @param symbol - declared name.
 * @returns declaration text including JSDoc, or null when absent.
 */
export function sourceDeclaration(sourceRel: string, symbol: string): string | null {
  const { text, sourceFile: sf } = loadSource(sourceRel)
  for (const stmt of sf.statements) {
    if (namedDeclarationName(stmt) === symbol) {
      const declarationStart = stmt.getStart(sf)
      const jsDoc = sourceJSDoc(text, stmt)
      const declaration = stripExport(text.slice(declarationStart, stmt.getEnd()))
      return withJSDoc(jsDoc, declaration)
    }
  }
  return null
}

export interface InterfacePart {
  text: string
  sourceFile: SourceFile
  declaration: InterfaceDeclaration
}

/** Find one top-level interface declaration in a source file. */
export function sourceInterface(sourceRel: string, symbol: string): InterfacePart | null {
  const { text, sourceFile } = loadSource(sourceRel)
  const declaration = sourceFile.statements.find((statement): statement is InterfaceDeclaration =>
    isInterfaceDeclaration(statement) && statement.name.text === symbol)
  return declaration === undefined ? null : { text, sourceFile, declaration }
}

/** Find one interface declaration inside an explicit string-literal module augmentation. */
export function augmentedInterface(sourceRel: string, moduleName: string, symbol: string): InterfacePart | null {
  const { text, sourceFile } = loadSource(sourceRel)
  for (const statement of sourceFile.statements) {
    if (!isModuleDeclaration(statement) || !isStringLiteral(statement.name)
      || statement.name.text !== moduleName || statement.body === undefined
      || !isModuleBlock(statement.body)) continue
    const declaration = statement.body.statements.find((member): member is InterfaceDeclaration =>
      isInterfaceDeclaration(member) && member.name.text === symbol)
    if (declaration !== undefined) return { text, sourceFile, declaration }
  }
  return null
}

function isNamedMember(member: ClassElement): member is ConstructorDeclaration | MethodDeclaration
  | GetAccessorDeclaration | SetAccessorDeclaration | PropertyDeclaration {
  return isConstructorDeclaration(member) || isMethodDeclaration(member)
    || isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member)
    || isPropertyDeclaration(member)
}

function classMemberName(member: ClassElement): Node | undefined {
  if (isNamedMember(member)) return member.name
  return undefined
}

function flagsOf(member: ClassElement): readonly { kind: SyntaxKind }[] | undefined {
  if (isNamedMember(member)) return member.modifiers
  return undefined
}

function isPublicMember(member: ClassElement): boolean {
  if (isClassStaticBlockDeclaration(member)) return false
  const name = classMemberName(member)
  if (name !== undefined && isPrivateIdentifier(name)) return false
  return !(flagsOf(member)?.some(modifier =>
    modifier.kind === SyntaxKind.PrivateKeyword
    || modifier.kind === SyntaxKind.ProtectedKeyword) ?? false)
}

function bodylessMember(text: string, sf: SourceFile, member: ClassElement): string {
  const start = member.getStart(sf)
  let end = member.end
  if (isConstructorDeclaration(member) || isMethodDeclaration(member)
    || isGetAccessorDeclaration(member) || isSetAccessorDeclaration(member)) {
    if (member.body !== undefined) end = member.body.getStart(sf)
  }
  if (isPropertyDeclaration(member) && member.initializer !== undefined) end = member.initializer.getStart(sf)
  const signature = text.slice(start, end).trimEnd().replace(/;$/, '').replace(/=\s*$/, '').trimEnd()
  return `${signature};`
}

/** Render a class as an ambient public declaration. */
export function sourcePublicApi(sourceRel: string, symbol: string): string | null {
  const { text, sourceFile: sf } = loadSource(sourceRel)
  for (const stmt of sf.statements) {
    if (!isClassDeclaration(stmt) || stmt.name?.text !== symbol) continue
    const classDoc = sourceJSDoc(text, stmt)
    const abstractKw = stmt.modifiers?.some(modifier => modifier.kind === SyntaxKind.AbstractKeyword) ? 'abstract ' : ''
    const typeParameters = stmt.typeParameters?.map(parameter => parameter.getText(sf)).join(', ')
    const heritage = stmt.heritageClauses?.map(clause => clause.getText(sf)).join(' ')
    const header = `declare ${abstractKw}class ${symbol}${typeParameters ? `<${typeParameters}>` : ''}${heritage ? ` ${heritage}` : ''} {`
    const members = stmt.members
      .filter(isPublicMember)
      .map((member) => {
        const jsDoc = sourceJSDoc(text, member)
        const declaration = bodylessMember(text, sf, member)
        return withJSDoc(jsDoc, declaration)
      })
    const declaration = [header, ...members.map(member => member.split('\n').map(line => `  ${line}`).join('\n')), '}'].join('\n')
    return classDoc === '' ? declaration : `${classDoc}\n${declaration}`
  }
  return null
}

/** Render one interface plus named module augmentations as its merged declaration. */
export function mergedInterfaceDeclaration(entry: {
  symbol: string
  source: string
  augmentations?: ReadonlyArray<{ source: string; module: string }>
}): string | null {
  const base = sourceInterface(entry.source, entry.symbol)
  if (base === null) return null
  const additions: InterfacePart[] = []
  for (const augmentation of entry.augmentations ?? []) {
    const part = augmentedInterface(augmentation.source, augmentation.module, entry.symbol)
    if (part === null) return null
    additions.push(part)
  }
  const parts = [base, ...additions]
  const docs = parts.map(part => sourceJSDoc(part.text, part.declaration)).filter(Boolean)
  const typeParameters = base.declaration.typeParameters
    ?.map(parameter => parameter.getText(base.sourceFile)).join(', ')
  const heritage = parts.flatMap(part =>
    part.declaration.heritageClauses?.map(clause => clause.getText(part.sourceFile)) ?? [],
  ).join(' ')
  const header = `interface ${entry.symbol}${typeParameters ? `<${typeParameters}>` : ''}${heritage ? ` ${heritage}` : ''} {`
  const members = parts.flatMap(part => part.declaration.members.map((member) => {
    const jsDoc = sourceJSDoc(part.text, member)
    const declaration = part.text.slice(member.getStart(part.sourceFile), member.getEnd())
    return withJSDoc(jsDoc, declaration)
  }))
  const declaration = [header, ...members.map(member => member.split('\n').map(line => `  ${line}`).join('\n')), '}'].join('\n')
  return docs.length === 0 ? declaration : `${docs.join('\n')}\n${declaration}`
}

export { stripExport }
