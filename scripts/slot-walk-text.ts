/**
 * Source-text helpers for {@link ./slot-walk.ts}: line numbers, JSDoc slices,
 * and property-name text used when indexing SlotMap members.
 */
import type {
  Expression, Node, ObjectLiteralExpression, PropertyName,
  PropertySignatureDeclaration, SourceFile, TypeLiteralNode,
} from 'typescript/unstable/ast'
import {
  isIdentifier,
  isLiteralTypeNode,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertySignatureDeclaration,
  isStringLiteral,
} from 'typescript/unstable/ast/is'

/** 1-based line of a node's first character. */
export function lineOf(sf: SourceFile, node: Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/** Declaration text including leading JSDoc, with container indentation removed. */
export function declarationText(statement: Node, sf: SourceFile): string {
  return dedent(sf.text.slice(statement.getStart(sf, true), statement.getEnd()))
}

/** One member's JSDoc comment text, '' when the member has none. */
export function jsDocOf(member: Node, sf: SourceFile): string {
  const withDoc = member.getStart(sf, true)
  const withoutDoc = member.getStart(sf, false)
  if (withDoc >= withoutDoc) return ''
  return dedent(sf.text.slice(withDoc, withoutDoc).trimEnd())
}

/** Strip the shared leading indentation of a multi-line source slice. */
export function dedent(text: string): string {
  const lines = text.split('\n')
  const indents = lines.slice(1).filter(line => line.trim() !== '')
    .map((line) => {
      const match = /^\s*/.exec(line)
      return match === null ? 0 : match[0].length
    })
  const shared = indents.length === 0 ? 0 : Math.min(...indents)
  return [lines[0] ?? '', ...lines.slice(1).map(line => line.slice(shared))].join('\n').trimEnd()
}

/** Collapse a type text to one line so catalog rows stay one row. */
export function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** A type-literal member's string-literal type text, '' when absent or computed. */
export function literalMember(entry: TypeLiteralNode | undefined, name: string): string {
  const member = namedMember(entry, name)
  if (member === undefined) return ''
  return isLiteralTypeNode(member.type) && isStringLiteral(member.type.literal)
    ? member.type.literal.text
    : ''
}

/** A type-literal member's type text on one line, absent when the member is. */
export function memberTypeText(
  entry: TypeLiteralNode | undefined,
  name: string,
  sf: SourceFile,
): string | undefined {
  const member = namedMember(entry, name)
  return member === undefined ? undefined : collapse(member.type.getText(sf))
}

/** One named property signature of a type literal. */
export function namedMember(
  entry: TypeLiteralNode | undefined,
  name: string,
): PropertySignatureDeclaration | undefined {
  if (entry === undefined) return undefined
  for (const member of entry.members) {
    if (isPropertySignatureDeclaration(member) && memberName(member.name) === name) return member
  }
  return undefined
}

/** A property name's text, quotes removed. */
export function memberName(name: PropertyName): string {
  return isStringLiteral(name) || isIdentifier(name) ? name.text : name.getText()
}

/** One string-literal property of an options object literal. */
export function stringProperty(options: ObjectLiteralExpression, name: string): string | undefined {
  for (const property of options.properties) {
    if (!isPropertyAssignment(property)) continue
    if (memberName(property.name) !== name) continue
    if (isStringLiteral(property.initializer)) return property.initializer.text
  }
  return undefined
}

/** The SlotMap keys a registration's `children` table declares. */
export function childKeys(options: ObjectLiteralExpression): string[] {
  for (const property of options.properties) {
    if (!isPropertyAssignment(property)) continue
    if (memberName(property.name) !== 'children') continue
    if (!isObjectLiteralExpression(property.initializer)) return []
    return property.initializer.properties
      .filter(isPropertyAssignment)
      .map(child => memberName(child.name))
  }
  return []
}

/** The component argument as written; a non-identifier expression is collapsed. */
export function componentText(argument: Expression | undefined, sf: SourceFile): string {
  if (argument === undefined) return '(none)'
  const text = collapse(argument.getText(sf))
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}
