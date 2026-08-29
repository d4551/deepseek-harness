/**
 * Remote method invocation models.
 */

import type { ClassDeclaration, MethodDeclaration, SourceFile } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import { isClassDeclaration, isIdentifier, isMethodDeclaration } from 'typescript/unstable/ast/is'
import type { FaceContext } from './analyzer-context.ts'
import { remoteBoundary } from './analyzer-codec.ts'
import { TypertAnalysisError } from './analyzer-error.ts'
import { gatewayBinding } from './analyzer-gateway.ts'
import { contextDeclarations, lookupDeclarations } from './analyzer-maps.ts'
import { isGlobalAbortSignal, remoteMarker, remoteResultType } from './analyzer-markers.ts'
import { isWorkspaceClass } from './analyzer-meta.ts'
import type { PackageRegistration } from './analyzer-types.ts'
import type { InvocationModel, InvocationParameterModel, PackageModel } from './model.ts'
import { hasModifier, visibilityOf } from './ts7-syntax.ts'

/**
 * Collect Remote methods from reachable package files.
 * @param face - extraction context.
 * @param registration - current package.
 * @param reachable - package source files.
 * @returns invocation models.
 */
export function collectInvocations(
  face: FaceContext,
  registration: PackageRegistration,
  reachable: readonly SourceFile[],
): InvocationModel[] {
  const result: InvocationModel[] = []
  for (const sourceFile of reachable) {
    for (const statement of sourceFile.statements) {
      if (!isClassDeclaration(statement)) continue
      collectClassInvocations(face, registration, statement, result)
    }
  }
  return result
}

function collectClassInvocations(
  face: FaceContext,
  registration: PackageRegistration,
  statement: ClassDeclaration,
  result: InvocationModel[],
) {
  const marked = statement.members.flatMap((member) => {
    const invocation = remoteMarker(face, member)
    if (invocation === undefined) return []
    if (!isMethodDeclaration(member)) face.fail(member, 'Remote decorators require a public instance method')
    return [{ method: member, invocation }]
  })
  const first = marked[0]
  if (first === undefined) return
  const binding = gatewayBinding(face, statement)
  if (binding === undefined) {
    face.fail(first.method, 'Remote methods require TypertRemoteService or readonly typertGateway = bindTypertRemote(this, serviceKey)')
  }
  for (const { method, invocation } of marked) {
    result.push(invocationModel(face, registration, binding, method, invocation))
  }
}

function invocationModel(
  face: FaceContext,
  registration: PackageRegistration,
  binding: { readonly service: string; readonly namespace: string },
  method: MethodDeclaration,
  invocation: ReturnType<typeof remoteMarker> & object,
): InvocationModel {
  if (invocation === undefined) face.fail(method, 'Remote marker missing')
  if (visibilityOf(method) !== 'public' || hasModifier(method, SyntaxKind.StaticKeyword)) {
    face.fail(method, 'Remote decorators require a public instance method')
  }
  if (hasModifier(method, SyntaxKind.AbstractKeyword) || method.body === undefined) {
    face.fail(method, 'Remote methods must have a concrete implementation')
  }
  if (!isIdentifier(method.name)) face.fail(method, 'Remote method names must be identifiers')
  if ((method.typeParameters?.length ?? 0) > 0) face.fail(method, 'generic Remote methods are not supported')
  const methodName = method.name.text
  const exportedMethod = invocation.exportName ?? methodName
  const parameters: InvocationParameterModel[] = []
  const wires = new Set<string>()
  let cancellation: InvocationModel['cancellation']
  for (const [parameterIndex, parameter] of method.parameters.entries()) {
    const modeled = oneParameter(face, registration, binding, method, exportedMethod, parameter, parameterIndex, method.parameters.length)
    if (modeled === 'signal') {
      cancellation = { parameter: 'signal' }
      continue
    }
    if (wires.has(modeled.wire)) face.fail(parameter, `duplicate Remote wire field ${modeled.wire}`)
    wires.add(modeled.wire)
    parameters.push(modeled)
  }
  const receiver = invocationReceiver(face, registration, binding, method, invocation, exportedMethod, wires)
  const scope = invocationScope(face, registration, binding, method, invocation, exportedMethod, parameters)
  const mode = invocation.kind === 'direct' ? invocation.mode : undefined
  return {
    id: `${registration.name}#${binding.namespace}/${exportedMethod}`,
    service: binding.service,
    namespace: binding.namespace,
    method: exportedMethod,
    ...exportedMethod === methodName ? {} : { implementation: methodName },
    ...mode === undefined ? {} : { mode },
    invocation: receiver,
    ...scope === undefined ? {} : { scope },
    parameters,
    ...cancellation === undefined ? {} : { cancellation },
    result: remoteBoundary(
      face,
      remoteResultType(face, method, mode),
      `${registration.name}#${binding.namespace}/${exportedMethod}:result`,
      false,
      'undefined-or-void',
    ),
    location: face.location(method.name),
  }
}

function oneParameter(
  face: FaceContext,
  registration: PackageRegistration,
  binding: { readonly namespace: string },
  method: MethodDeclaration,
  exportedMethod: string,
  parameter: MethodDeclaration['parameters'][number],
  parameterIndex: number,
  parameterCount: number,
): InvocationParameterModel | 'signal' {
  if (!isIdentifier(parameter.name)) face.fail(parameter, 'Remote parameters must use identifier bindings')
  if (parameter.dotDotDotToken !== undefined) face.fail(parameter, 'Remote parameters cannot be rest parameters')
  if (parameter.initializer !== undefined) face.fail(parameter, 'Remote parameters cannot have default values')
  if (parameter.name.text === 'this') face.fail(parameter, 'Remote methods cannot declare an explicit this parameter')
  const optional = parameter.questionToken !== undefined
  const authoredType = face.requiredType(parameter, parameter.type, 'parameter')
  const cancellationName = parameter.name.text === 'signal'
  const cancellationType = isGlobalAbortSignal(face, authoredType)
  if (cancellationName || cancellationType) {
    if (!cancellationName || !cancellationType) {
      face.fail(parameter, 'Remote cancellation must use a parameter named signal with the global AbortSignal type')
    }
    if (parameterIndex !== parameterCount - 1) face.fail(parameter, 'Remote cancellation signal must be the final parameter')
    return 'signal'
  }
  const lookups = lookupDeclarations(face)
  const lookupByHost = new Map(lookups.flatMap(lookup => lookup.hostSymbol === undefined ? [] : [[lookup.hostSymbol, lookup]]))
  const hostSymbol = face.symbolAtType(authoredType)
  const lookup = hostSymbol === undefined ? undefined : lookupByHost.get(face.symbolId(hostSymbol))
  if (lookup !== undefined) {
    if (optional) face.fail(parameter, `lookup parameter for ${lookup.key} cannot be optional`)
    if (parameter.name.text !== lookup.key) {
      face.fail(parameter, `lookup parameter for ${lookup.key} must also be named ${lookup.key}`)
    }
    return {
      name: parameter.name.text,
      wire: `${lookup.key}Id`,
      source: 'lookup',
      lookup: lookup.key,
      boundary: remoteBoundary(face, lookup.wireType, `${registration.name}#${binding.namespace}/${exportedMethod}:${lookup.key}Id`, true),
    }
  }
  if (hostSymbol !== undefined && isWorkspaceClass(face, hostSymbol)) {
    face.fail(parameter, `non-JSON class parameter ${hostSymbol.name} requires a TypertLookupMap entry`)
  }
  return {
    name: parameter.name.text,
    wire: parameter.name.text,
    source: 'json',
    ...optional ? { optional: true as const } : {},
    boundary: remoteBoundary(
      face,
      authoredType,
      `${registration.name}#${binding.namespace}/${exportedMethod}:${parameter.name.text}`,
      false,
      'undefined',
      optional,
    ),
  }
}

function invocationReceiver(
  face: FaceContext,
  registration: PackageRegistration,
  binding: { readonly namespace: string },
  method: MethodDeclaration,
  invocation: NonNullable<ReturnType<typeof remoteMarker>>,
  exportedMethod: string,
  wires: Set<string>,
): InvocationModel['invocation'] {
  if (invocation.kind !== 'context') return { kind: 'direct' }
  const context = contextDeclarations(face).get(invocation.context)
  if (context === undefined) face.fail(method, `Remote Scope ${invocation.context} has no TypertContextMap entry`)
  const wire = `${invocation.context}Id`
  if (wires.has(wire)) face.fail(method, `Remote Scope wire field ${wire} conflicts with a method parameter`)
  return {
    kind: 'context',
    context: invocation.context,
    wire,
    boundary: remoteBoundary(face, context.wireType, `${registration.name}#${binding.namespace}/${exportedMethod}:${wire}`, true),
  }
}

function invocationScope(
  face: FaceContext,
  registration: PackageRegistration,
  binding: { readonly namespace: string },
  method: MethodDeclaration,
  invocation: NonNullable<ReturnType<typeof remoteMarker>>,
  exportedMethod: string,
  parameters: InvocationParameterModel[],
): InvocationModel['scope'] {
  if (invocation.kind !== 'direct') return undefined
  const lookupParameters = parameters.filter(parameter => parameter.source === 'lookup')
  const parameter = lookupParameters.length === 1 ? lookupParameters[0] : undefined
  const context = parameter?.lookup === undefined ? undefined : contextDeclarations(face).get(parameter.lookup)
  if (parameter === undefined || context === undefined) return undefined
  const contextBoundary = remoteBoundary(
    face,
    context.wireType,
    `${registration.name}#${binding.namespace}/${exportedMethod}:scope:${context.key}`,
    true,
  )
  if (contextBoundary.typeSymbol !== parameter.boundary.typeSymbol) {
    face.fail(
      method,
      `Remote scope ${context.key} wire type ${contextBoundary.typeSymbol} does not match lookup wire type ${parameter.boundary.typeSymbol}`,
    )
  }
  return { context: context.key, wire: parameter.wire }
}

export function validateInvocationIdentity(face: FaceContext, packages: readonly PackageModel[]) {
  const endpoints = new Map<string, InvocationModel>()
  const ids = new Map<string, InvocationModel>()
  for (const invocation of packages.flatMap(packageModel => packageModel.invocations)) {
    const endpoint = `${invocation.namespace}/${invocation.method}`
    const existingEndpoint = endpoints.get(endpoint)
    if (existingEndpoint !== undefined) {
      throw new TypertAnalysisError(
        `typert(${face.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote endpoint ${endpoint} conflicts with ${existingEndpoint.id}`,
      )
    }
    const existingId = ids.get(invocation.id)
    if (existingId !== undefined) {
      throw new TypertAnalysisError(
        `typert(${face.face}): ${invocation.location.file}:${String(invocation.location.line)}:${String(invocation.location.column)}: Remote invocation id ${invocation.id} conflicts with ${existingId.id}`,
      )
    }
    endpoints.set(endpoint, invocation)
    ids.set(invocation.id, invocation)
  }
}
