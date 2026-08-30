/**
 * Class and interface member extraction.
 */

import type {
  ClassElement,
  Node,
  PropertyName,
  SignatureDeclaration,
  TypeElement,
  TypeNode,
  TypeParameterDeclaration,
} from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isCallSignatureDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isConstructSignatureDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isIndexSignatureDeclaration,
  isMethodDeclaration,
  isMethodSignatureDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isObjectBindingPattern,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { TypeFlags } from 'typescript/unstable/sync'
import type { FaceContext } from './analyzer-context.ts'
import { convertType } from './analyzer-convert.ts'
import { documentationOf, memberName } from './analyzer-docs.ts'
import { memberText } from './analyzer-literals.ts'
import { expressionName } from './analyzer-names.ts'
import type {
  MemberBase,
  MemberModel,
  MemberVisibility,
  ParameterModel,
  SignatureModel,
  TypeParameterModel,
} from './model.ts'
import { hasModifier, isNamedMember, isOptionalMember, visibilityOf } from './ts7-syntax.ts'

/**
 * Public instance members of a class, interface, or type literal.
 * @param face - extraction context.
 * @param members - class or type elements.
 * @param ownerId - owning declaration or object-node id.
 * @returns extracted public members.
 */
export function collectMembers(
  face: FaceContext,
  members: readonly (TypeElement | ClassElement)[],
  ownerId: string,
): MemberModel[] {
  const result: MemberModel[] = []
  for (const member of members) {
    if (skipMember(member, members)) continue
    const visibility = visibilityOf(member)
    const isStatic = hasModifier(member, SyntaxKind.StaticKeyword)
    if (visibility !== 'public' || isStatic || isConstructorDeclaration(member)) continue
    const base = memberBase(face, member, ownerId, visibility, isStatic)
    pushMember(face, result, member, base)
  }
  return result
}

function skipMember(
  member: TypeElement | ClassElement,
  members: readonly (TypeElement | ClassElement)[],
): boolean {
  if (isPropertyDeclaration(member)
    && memberName(member.name) === 'typertRemote'
    && member.initializer !== undefined
    && isCallExpression(member.initializer)
    && expressionName(member.initializer.expression) === 'bindTypertRemote') return true
  if (!isMethodDeclaration(member) || member.body === undefined) return false
  return members.some(candidate => candidate !== member
    && (isMethodDeclaration(candidate) || isMethodSignatureDeclaration(candidate))
    && memberName(candidate.name) === memberName(member.name)
    && (!isMethodDeclaration(candidate) || candidate.body === undefined))
}

function pushMember(face: FaceContext, result: MemberModel[], member: TypeElement | ClassElement, base: MemberBase) {
  if (isPropertySignatureDeclaration(member) || isPropertyDeclaration(member)) {
    result.push({ ...base, kind: 'property', type: convertType(face, face.requiredType(member, member.type, 'property')) })
  } else if (isMethodSignatureDeclaration(member) || isMethodDeclaration(member)) {
    result.push({ ...base, kind: 'method', signature: functionSignature(face, member, member.type) })
  } else if (isGetAccessorDeclaration(member)) {
    result.push({ ...base, kind: 'getter', signature: functionSignature(face, member, member.type) })
  } else if (isSetAccessorDeclaration(member)) {
    result.push({ ...base, kind: 'setter', signature: functionSignature(face, member, member.type) })
  } else if (isCallSignatureDeclaration(member)) {
    result.push({ ...base, kind: 'call', signature: functionSignature(face, member, member.type) })
  } else if (isConstructSignatureDeclaration(member)) {
    result.push({ ...base, kind: 'construct', signature: functionSignature(face, member, member.type) })
  } else if (isIndexSignatureDeclaration(member)) {
    result.push({ ...base, kind: 'index', signature: functionSignature(face, member, member.type) })
  }
}

function memberBase(
  face: FaceContext,
  member: TypeElement | ClassElement,
  ownerId: string,
  visibility: MemberVisibility,
  isStatic: boolean,
): MemberBase {
  const identity = isNamedMember(member)
    ? memberIdentity(face, member.name)
    : {
      name: isCallSignatureDeclaration(member)
        ? '(call)'
        : isConstructSignatureDeclaration(member)
          ? '(construct)'
          : '(index)',
    }
  return {
    ...documentationOf(member),
    id: `${ownerId}#${identity.name}@${String(member.getStart())}`,
    ...identity,
    optional: isOptionalMember(member),
    readonly: hasModifier(member, SyntaxKind.ReadonlyKeyword),
    async: hasModifier(member, SyntaxKind.AsyncKeyword),
    abstract: hasModifier(member, SyntaxKind.AbstractKeyword),
    static: isStatic,
    visibility,
    location: face.location(member),
    text: memberText(member),
  }
}

function memberIdentity(face: FaceContext, name: PropertyName): Pick<MemberBase, 'name' | 'jsonName' | 'computed'> {
  if (!isComputedPropertyName(name)) return { name: memberName(name) }
  const expression = name.expression
  if (isStringLiteral(expression) || isNumericLiteral(expression)
    || isNoSubstitutionTemplateLiteral(expression)) {
    return { name: memberName(name), jsonName: expression.text }
  }
  const type = face.checker.getTypeAtLocation(expression)
  return {
    name: memberName(name),
    computed: type !== undefined && (type.flags & TypeFlags.UniqueESSymbol) !== 0 ? 'symbol' : 'dynamic',
  }
}

/**
 * Signature of a method, function type, or index/call/construct member.
 * @param face - extraction context.
 * @param node - signature-bearing node.
 * @param explicitReturn - authored return type, if any.
 * @returns the signature model.
 */
export function functionSignature(face: FaceContext, node: SignatureDeclaration, explicitReturn: TypeNode | undefined): SignatureModel {
  const parameters: ParameterModel[] = node.parameters.map(parameter => ({
    // A parameter carries a BindingName, not the PropertyName `memberName`
    // reads: an identifier keeps its text, a binding pattern prints itself.
    name: isIdentifier(parameter.name) ? parameter.name.text : parameter.name.getText(),
    binding: isIdentifier(parameter.name)
      ? 'identifier'
      : isObjectBindingPattern(parameter.name)
        ? 'object'
        : 'array',
    type: convertType(face, face.requiredType(parameter, parameter.type, 'parameter')),
    optional: parameter.questionToken !== undefined || parameter.initializer !== undefined,
    rest: parameter.dotDotDotToken !== undefined,
    receiver: isIdentifier(parameter.name) && parameter.name.text === 'this',
    ...parameter.initializer === undefined ? {} : { initializer: parameter.initializer.getText() },
  }))
  return {
    typeParameters: typeParametersOf(face, node.typeParameters),
    parameters,
    returns: isSetAccessorDeclaration(node)
      ? face.addNode(node, { kind: 'keyword', name: 'void' })
      : convertType(face, face.requiredType(node, explicitReturn, 'return')),
  }
}

/**
 * Type-parameter list on a declaration or signature.
 * @param face - extraction context.
 * @param parameters - type-parameter nodes.
 * @returns models, empty when the list is absent.
 */
export function typeParametersOf(
  face: FaceContext,
  parameters: readonly TypeParameterDeclaration[] | undefined,
): TypeParameterModel[] {
  return parameters?.map(parameter => ({
    id: `${face.locationKey(parameter)}#${parameter.name.text}`,
    name: parameter.name.text,
    const: hasModifier(parameter, SyntaxKind.ConstKeyword),
    ...parameter.constraint === undefined ? {} : { constraint: convertType(face, parameter.constraint) },
    ...parameter.defaultType === undefined ? {} : { default: convertType(face, parameter.defaultType) },
    ...hasModifier(parameter, SyntaxKind.InKeyword) && hasModifier(parameter, SyntaxKind.OutKeyword)
      ? { variance: 'in-out' as const }
      : hasModifier(parameter, SyntaxKind.InKeyword)
        ? { variance: 'in' as const }
        : hasModifier(parameter, SyntaxKind.OutKeyword)
          ? { variance: 'out' as const }
          : {},
  })) ?? []
}

/**
 * Reconcile the type parameters of a declaration-merged interface.
 * @param face - extraction context.
 * @param parts - one type-parameter list per merged declaration.
 * @param site - node the failure locates at.
 * @param name - merged interface name, used in the failure.
 * @returns the merged list, taking the first declared constraint and default
 *   at each position; empty when no declaration declares parameters.
 * @throws TypertAnalysisError when two declarations declare conflicting variance.
 */
export function mergeTypeParameters(
  face: FaceContext,
  parts: readonly (readonly TypeParameterModel[])[],
  site: Node,
  name: string,
): TypeParameterModel[] {
  const first = parts[0]
  if (first === undefined) return []
  return first.map((parameter, index) => {
    const peers = parts.map(part => part[index]).filter((peer): peer is TypeParameterModel => peer !== undefined)
    const constraint = peers.find(peer => peer.constraint !== undefined)?.constraint
    const fallback = peers.find(peer => peer.default !== undefined)?.default
    const variances = [...new Set(peers.flatMap(peer => peer.variance === undefined ? [] : [peer.variance]))]
    if (variances.length > 1) face.fail(site, `merged interface ${name} has incompatible variance modifiers`)
    return {
      id: parameter.id,
      name: parameter.name,
      const: peers.some(peer => peer.const),
      ...constraint === undefined ? {} : { constraint },
      ...fallback === undefined ? {} : { default: fallback },
      ...variances[0] === undefined ? {} : { variance: variances[0] },
    }
  })
}
