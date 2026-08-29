/**
 * bindTypertRemote field and TypertRemoteService super() bindings.
 */

import type { CallExpression, ClassDeclaration, Node } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isConstructorDeclaration,
  isExpressionStatement,
  isObjectLiteralExpression,
  isPropertyAssignment,
  isPropertyDeclaration,
} from 'typescript/unstable/ast/is'
import type { FaceContext } from './analyzer-context.ts'
import { memberName } from './analyzer-docs.ts'
import { isTypeMetaSymbol } from './analyzer-meta.ts'
import { isRemoteSegment, stringLiteralValue } from './analyzer-names.ts'
import type { GatewayBinding } from './analyzer-remote-types.ts'
import { hasModifier, visibilityOf } from './ts7-syntax.ts'

/**
 * Gateway binding on a remote service class, if one is declared.
 * @param face - extraction context.
 * @param declaration - service class.
 * @returns the service key and namespace, or undefined when the class is not a gateway.
 */
export function gatewayBinding(face: FaceContext, declaration: ClassDeclaration): GatewayBinding | undefined {
  const field = gatewayFieldBinding(face, declaration)
  const base = gatewayServiceBinding(face, declaration)
  if (field !== undefined && base !== undefined) {
    face.fail(field.site, 'TypertRemoteService subclasses must not declare a second typertRemote binding')
  }
  return field ?? base
}

function gatewayFieldBinding(face: FaceContext, declaration: ClassDeclaration): GatewayBinding | undefined {
  const candidates = declaration.members.filter((member): member is import('typescript/unstable/ast').PropertyDeclaration =>
    isPropertyDeclaration(member) && memberName(member.name) === 'typertRemote')
  const property = candidates[0]
  const duplicate = candidates[1]
  if (property === undefined) return undefined
  if (duplicate !== undefined) face.fail(duplicate, 'Service has more than one typertGateway field')
  if (visibilityOf(property) !== 'public'
    || hasModifier(property, SyntaxKind.StaticKeyword)
    || !hasModifier(property, SyntaxKind.ReadonlyKeyword)) {
    face.fail(property, 'typertGateway must be a public readonly instance field')
  }
  if (property.initializer === undefined
    || !isCallExpression(property.initializer)
    || !isTypeMetaSymbol(face, property.initializer.expression, 'bindTypertRemote')) {
    face.fail(property, 'typertGateway must call bindTypertRemote()')
  }
  const call = property.initializer
  if (call.arguments.length < 2 || call.arguments.length > 3) {
    face.fail(call, 'bindTypertRemote() requires this, service key, and an optional options object')
  }
  if (call.arguments[0]?.kind !== SyntaxKind.ThisKeyword) {
    face.fail(call.arguments[0] ?? call, 'bindTypertRemote() first argument must be this')
  }
  return gatewayBindingArguments(face, call, property)
}

function gatewayServiceBinding(face: FaceContext, declaration: ClassDeclaration): GatewayBinding | undefined {
  const heritage = (declaration.heritageClauses ?? [])
    .filter(clause => clause.token === SyntaxKind.ExtendsKeyword)
    .flatMap(clause => [...clause.types])
    .find(type => isTypeMetaSymbol(face, type.expression, 'TypertRemoteService'))
  if (heritage === undefined) return undefined
  const constructor = declaration.members.find(isConstructorDeclaration)
  if (constructor?.body === undefined) {
    face.fail(heritage, 'TypertRemoteService subclasses must declare a constructor with super(ctx, serviceKey)')
  }
  const call = constructor.body.statements.flatMap((statement) => {
    if (!isExpressionStatement(statement) || !isCallExpression(statement.expression)) return []
    return statement.expression.expression.kind === SyntaxKind.SuperKeyword ? [statement.expression] : []
  })[0]
  if (call === undefined) {
    face.fail(constructor, 'TypertRemoteService constructor must call super(ctx, serviceKey) directly')
  }
  if (call.arguments.length < 2 || call.arguments.length > 3) {
    face.fail(call, 'TypertRemoteService super() requires context, service key, and an optional options object')
  }
  return gatewayBindingArguments(face, call, heritage)
}

function gatewayBindingArguments(face: FaceContext, call: CallExpression, site: Node): GatewayBinding {
  const serviceArgument = call.arguments[1]
  if (serviceArgument === undefined) face.fail(call, 'Gateway service key must be a string literal')
  const service = stringLiteralValue(serviceArgument)
  if (service === undefined) face.fail(serviceArgument, 'Gateway service key must be a string literal')
  let namespace = service
  const options = call.arguments[2]
  if (options !== undefined) {
    if (!isObjectLiteralExpression(options)) face.fail(options, 'bindTypertRemote() options must be an object literal')
    for (const propertyOption of options.properties) {
      if (!isPropertyAssignment(propertyOption) || memberName(propertyOption.name) !== 'namespace') {
        face.fail(propertyOption, 'bindTypertRemote() only supports a namespace option')
      }
      const value = stringLiteralValue(propertyOption.initializer)
      if (value === undefined) face.fail(propertyOption.initializer, 'Gateway namespace must be a string literal')
      namespace = value
    }
  }
  if (!isRemoteSegment(service)) {
    face.fail(serviceArgument, 'Gateway service key must contain only RPC endpoint segment characters')
  }
  if (!isRemoteSegment(namespace)) {
    face.fail(options ?? call, 'Gateway namespace must contain only RPC endpoint segment characters')
  }
  return { service, namespace, site }
}
