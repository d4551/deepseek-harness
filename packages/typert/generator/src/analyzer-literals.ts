/**
 * Literal and type-operator rendering for authored TypeNode conversion.
 */

import type { LiteralTypeNode, Node } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isBigIntLiteral,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrefixUnaryExpression,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { TypertAnalysisError } from './analyzer-error.ts'
import type { TypeNodeModel, TypeOperatorName } from './model.ts'

export function literalModel(node: LiteralTypeNode): Omit<Extract<TypeNodeModel, { kind: 'literal' }>, 'id'> {
  const literal = node.literal
  if (isStringLiteral(literal)) return { kind: 'literal', value: literal.text, text: literal.getText() }
  if (isNoSubstitutionTemplateLiteral(literal)) {
    return { kind: 'literal', value: literal.text, text: literal.getText() }
  }
  if (isNumericLiteral(literal)) return { kind: 'literal', value: Number(literal.text), text: literal.getText() }
  if (isBigIntLiteral(literal)) return { kind: 'literal', value: BigInt(literal.text.slice(0, -1)), text: literal.getText() }
  if (literal.kind === SyntaxKind.TrueKeyword) return { kind: 'literal', value: true, text: 'true' }
  if (literal.kind === SyntaxKind.FalseKeyword) return { kind: 'literal', value: false, text: 'false' }
  if (literal.kind === SyntaxKind.NullKeyword) return { kind: 'literal', value: null, text: 'null' }
  if (isPrefixUnaryExpression(literal)
    && (isNumericLiteral(literal.operand) || isBigIntLiteral(literal.operand))) {
    return {
      kind: 'literal',
      value: isBigIntLiteral(literal.operand)
        ? BigInt(literal.getText().slice(0, -1))
        : Number(literal.getText()),
      text: literal.getText(),
    }
  }
  throw new TypertAnalysisError(`typert: unsupported literal type ${literal.getText()}`)
}

export function typeOperatorName(kind: SyntaxKind): TypeOperatorName {
  if (kind === SyntaxKind.KeyOfKeyword) return 'keyof'
  if (kind === SyntaxKind.ReadonlyKeyword) return 'readonly'
  return 'unique'
}

export function modifierMode(token: Node | undefined): 'add' | 'remove' | 'preserve' {
  if (token?.kind === SyntaxKind.PlusToken) return 'add'
  if (token?.kind === SyntaxKind.MinusToken) return 'remove'
  return token === undefined ? 'preserve' : 'add'
}

export function annotationPosition(
  node: Node,
  purpose: 'property' | 'parameter' | 'return',
): number {
  if (purpose === 'return' && 'parameters' in node) {
    const parameters = node.parameters
    if (parameters !== undefined && typeof parameters === 'object' && 'end' in parameters) {
      const end = Reflect.get(parameters, 'end')
      if (typeof end === 'number') return end + 1
    }
  }
  if ('name' in node && node.name !== undefined && typeof node.name === 'object' && 'end' in node.name) {
    const end = Reflect.get(node.name, 'end')
    if (typeof end === 'number') return end
  }
  return node.end
}

export function memberText(member: Node): string {
  const sourceFile = member.getSourceFile()
  const full = member.getText(sourceFile)
  if (!('body' in member) || member.body === undefined || typeof member.body !== 'object') {
    return full.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
  }
  const body = member.body
  if (!('getText' in body) || typeof body.getText !== 'function') {
    return full.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
  }
  const bodyText = body.getText(sourceFile)
  const signature = full.slice(0, full.length - bodyText.length)
  return signature.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

export function declarationName(node: { readonly name?: { readonly text: string } }): string {
  return node.name?.text ?? ''
}

export function importTypeModule(node: { readonly argument: Node }): string {
  const argument = node.argument
  if (!('literal' in argument)) return argument.getText()
  const literal = Reflect.get(argument, 'literal')
  if (literal !== null && typeof literal === 'object' && 'text' in literal && typeof literal.text === 'string') {
    return literal.text
  }
  return argument.getText()
}
