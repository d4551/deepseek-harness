/**
 * Literal and type-operator rendering for authored TypeNode conversion.
 */

import type { LiteralTypeNode, Node } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isBigIntLiteral,
  isFunctionLikeDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isParameterDeclaration,
  isPrefixUnaryExpression,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { isNamedMember } from './ts7-syntax.ts'
import { TypertAnalysisError } from './analyzer-error.ts'
import type { TypeNodeModel, TypeOperatorName } from './model.ts'

/**
 * Model one literal type, keeping both its value and its authored text.
 * @param node - literal type node.
 * @returns the literal model without its id.
 * @throws TypertAnalysisError when the literal is not a string, template,
 *   number, bigint, boolean, null, or signed numeric literal.
 */
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

/**
 * The model name of a type operator.
 * @param kind - operator keyword kind.
 * @returns `keyof`, `readonly`, or `unique` for any other operator keyword.
 */
export function typeOperatorName(kind: SyntaxKind): TypeOperatorName {
  if (kind === SyntaxKind.KeyOfKeyword) return 'keyof'
  if (kind === SyntaxKind.ReadonlyKeyword) return 'readonly'
  return 'unique'
}

/**
 * How a mapped-type modifier token changes the modifier it precedes.
 * @param token - `+`, `-`, the bare modifier, or undefined when absent.
 * @returns `preserve` when the token is absent, `remove` for `-`, `add` otherwise.
 */
export function modifierMode(token: Node | undefined): 'add' | 'remove' | 'preserve' {
  if (token?.kind === SyntaxKind.PlusToken) return 'add'
  if (token?.kind === SyntaxKind.MinusToken) return 'remove'
  return token === undefined ? 'preserve' : 'add'
}

/**
 * Where a missing type annotation would be written back.
 * @param node - declaration missing the annotation.
 * @param purpose - which position the annotation fills.
 * @returns the source offset the `: Type` text belongs at.
 */
export function annotationPosition(
  node: Node,
  purpose: 'property' | 'parameter' | 'return',
): number {
  if (purpose === 'return' && isFunctionLikeDeclaration(node)) return node.parameters.end + 1
  // A parameter's annotation belongs between its name and any initializer, so
  // the name's end is the insertion point; the parameter's own end sits after
  // the initializer, where a type annotation is a syntax error.
  if (purpose === 'parameter' && isParameterDeclaration(node)) return node.name.end
  if (isNamedMember(node)) return node.name.end
  return node.end
}

/**
 * A member's declaration text with its body removed and whitespace collapsed.
 * @param member - member declaration.
 * @returns the single-line signature text.
 */
export function memberText(member: Node): string {
  const sourceFile = member.getSourceFile()
  const full = member.getText(sourceFile)
  const collapse = (text: string): string => text.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
  const body = isFunctionLikeDeclaration(member) ? member.body : undefined
  if (body === undefined) return collapse(full)
  return collapse(full.slice(0, full.length - body.getText(sourceFile).length))
}

/**
 * The declared name of a node that carries one.
 * @param node - node with an optional name.
 * @returns the name text, empty when the node is unnamed.
 */
export function declarationName(node: { readonly name?: { readonly text: string } }): string {
  return node.name?.text ?? ''
}

/**
 * The specifier an `import(...)` type names.
 * @param node - import-type node.
 * @returns the literal specifier text, falling back to the argument's own text
 *   when the argument is not a string literal.
 */
export function importTypeModule(node: { readonly argument: Node }): string {
  const argument = node.argument
  if (!('literal' in argument)) return argument.getText()
  const literal = Reflect.get(argument, 'literal')
  if (literal !== null && typeof literal === 'object' && 'text' in literal && typeof literal.text === 'string') {
    return literal.text
  }
  return argument.getText()
}
