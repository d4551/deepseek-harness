/**
 * Remote() and RemoteScope() decorator markers, plus Promise/Iterable unwrap.
 */

import type { ClassElement, MethodDeclaration, Node, TypeNode } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isTypeReferenceNode,
} from 'typescript/unstable/ast/is'
import type { FaceContext } from './analyzer-context.ts'
import { memberName } from './analyzer-docs.ts'
import { isTypeMetaSymbol } from './analyzer-meta.ts'
import { isRemoteSegment, stringLiteralValue } from './analyzer-names.ts'
import { decoratorsOf, isDefaultLibraryDeclaration, preferredDeclaration, resolveDeclarations } from './ts7-syntax.ts'

export type DirectMarker = { readonly kind: 'direct'; readonly exportName?: string; readonly mode?: 'stream' }
export type ContextMarker = { readonly kind: 'context'; readonly context: string; readonly exportName?: string }
export type RemoteMarker = DirectMarker | ContextMarker

/**
 * Read the Remote / RemoteScope decorator on a class element, if any.
 * @param face - extraction context.
 * @param member - class element.
 * @returns the invocation marker.
 */
export function remoteMarker(face: FaceContext, member: ClassElement): RemoteMarker | undefined {
  let found: RemoteMarker | undefined
  for (const decorator of decoratorsOf(member)) {
    const marker = oneRemoteMarker(face, decorator.expression)
    if (marker === undefined) continue
    if (found !== undefined) face.fail(decorator, 'a method can have only one Remote invocation decorator')
    found = marker
  }
  return found
}

function oneRemoteMarker(face: FaceContext, expression: Node): RemoteMarker | undefined {
  if (isTypeMetaSymbol(face, expression, 'Remote')) return { kind: 'direct' }
  if (isCallExpression(expression) && isTypeMetaSymbol(face, expression.expression, 'Remote')) {
    return remoteCallMarker(face, expression)
  }
  if (isCallExpression(expression) && isTypeMetaSymbol(face, expression.expression, 'RemoteScope')) {
    return remoteScopeMarker(face, expression)
  }
  return undefined
}

function remoteCallMarker(face: FaceContext, expression: import('typescript/unstable/ast').CallExpression): DirectMarker {
  if (expression.arguments.length !== 1) face.fail(expression, 'Remote() requires one name or options object')
  const argument = expression.arguments[0]
  if (argument === undefined) face.fail(expression, 'Remote() requires one name or options object')
  const exportName = stringLiteralValue(argument)
  if (exportName !== undefined) {
    if (!isRemoteSegment(exportName)) {
      face.fail(argument, 'Remote() name must contain only RPC endpoint segment characters')
    }
    return { kind: 'direct', exportName }
  }
  if (!isObjectLiteralExpression(argument) || argument.properties.length !== 1) {
    face.fail(argument, 'Remote() options must contain exactly mode: "stream"')
  }
  const property = argument.properties[0]
  if (property === undefined) face.fail(argument, 'Remote() options must contain exactly mode: "stream"')
  if (!isPropertyAssignment(property) || memberName(property.name) !== 'mode'
    || stringLiteralValue(property.initializer) !== 'stream') {
    face.fail(property, 'Remote() options must contain exactly mode: "stream"')
  }
  return { kind: 'direct', mode: 'stream' }
}

function remoteScopeMarker(face: FaceContext, expression: import('typescript/unstable/ast').CallExpression): ContextMarker {
  if (expression.arguments.length < 1 || expression.arguments.length > 2) {
    face.fail(expression, 'RemoteScope() requires a Context key and optional exported method name')
  }
  const context = stringLiteralValue(expression.arguments[0])
  if (context === undefined || !isRemoteSegment(context)) {
    face.fail(expression.arguments[0] ?? expression, 'RemoteScope() key must be a string literal containing only RPC endpoint segment characters')
  }
  const exportArgument = expression.arguments[1]
  const exportName = exportArgument === undefined ? undefined : stringLiteralValue(exportArgument)
  if (exportArgument !== undefined && (exportName === undefined || !isRemoteSegment(exportName))) {
    face.fail(exportArgument, 'RemoteScope() name must be a string literal containing only RPC endpoint segment characters')
  }
  return { kind: 'context', context, ...exportName === undefined ? {} : { exportName } }
}

/**
 * Authored return type, unwrapping Promise / Iterable wrappers the Remote codec uses.
 * @param face - extraction context.
 * @param method - remote method.
 * @param mode - stream when the decorator requested Iterable.
 * @returns the payload type node.
 */
export function remoteResultType(face: FaceContext, method: MethodDeclaration, mode?: 'stream'): TypeNode {
  const authored = face.requiredType(method, method.type, 'return')
  if (isTypeReferenceNode(authored)) {
    const symbol = face.checker.getSymbolAtLocation(authored.typeName)
    const resolved = symbol === undefined ? undefined : face.resolveSymbol(symbol)
    const resultType = authored.typeArguments?.[0]
    const wrappers = mode === 'stream' ? ['Iterable', 'AsyncIterable'] : ['Promise']
    const declaration = resolved === undefined ? undefined : preferredDeclaration(resolved, face.project.project)
    if (resolved !== undefined && wrappers.includes(resolved.name) && resultType !== undefined
      && authored.typeArguments?.length === 1 && declaration !== undefined
      && isDefaultLibraryDeclaration(face.project.project, declaration)) {
      return resultType
    }
  }
  if (mode === 'stream') face.fail(method, 'stream Remote methods must return Iterable<T> or AsyncIterable<T>')
  return authored
}

export function isGlobalAbortSignal(face: FaceContext, type: TypeNode): boolean {
  const symbol = face.symbolAtType(type)
  if (symbol?.name !== 'AbortSignal') return false
  return resolveDeclarations(symbol, face.project.project)
    .some(declaration => isDefaultLibraryDeclaration(face.project.project, declaration))
}
