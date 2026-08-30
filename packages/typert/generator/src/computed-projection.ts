/**
 * Zod projections for computed authored types — `keyof` operators, indexed
 * accesses, and mapped types — evaluated against the type graph. The graph
 * carries merged interface members, so the discriminated-union idiom
 * `{ [K in keyof Map]: … }[keyof Map]` projects to a union of the per-key
 * object schemas without reaching back into the compiler.
 */

import type { MemberModel, TypeDeclarationModel, TypeNodeId, TypeNodeModel } from './model.ts'
import type { TypeGraphRenderer } from './renderer.ts'

/** Services the schema emitter hands to computed projection. */
export interface ComputedProjectionContext {
  readonly renderer: TypeGraphRenderer
  /** Re-enter schema emission for one node, carrying generic and literal-key substitutions. */
  schema(id: TypeNodeId, substitutions: ReadonlyMap<string, string>, keys: ReadonlyMap<string, string>): string
  fail(subject: string, message: string): never
}

/** Generic schema substitutions plus mapped-parameter literal keys. */
interface ProjectionState {
  readonly substitutions: ReadonlyMap<string, string>
  readonly keys: ReadonlyMap<string, string>
}

/**
 * Project one computed node, or return undefined when the construct exceeds
 * graph evaluation (the caller then fails with its unsupported diagnostic).
 * @param node - operator, indexed-access, or mapped node.
 * @param context - emitter services.
 * @param state - active substitutions.
 * @returns the Zod expression, or undefined.
 */
export function computedSchema(
  node: TypeNodeModel,
  context: ComputedProjectionContext,
  state: ProjectionState,
): string | undefined {
  if (node.kind === 'operator' && node.operator === 'keyof') {
    const names = keyOfNames(node.type, context, state)
    if (names === undefined) return undefined
    return unionOfLiterals(names)
  }
  if (node.kind === 'indexed-access') {
    return indexedAccessSchema(node, context, state)
  }
  if (node.kind === 'mapped') {
    return mappedSchema(node, context, state)
  }
  return undefined
}

function unionOfLiterals(names: readonly string[]): string {
  if (names.length === 0) return 'z.never()'
  if (names.length === 1) return `z.literal(${quoteKey(names[0] as string)})`
  return `z.union([${names.map(name => 'z.literal(' + quoteKey(name) + ')').join(', ')}])`
}

/**
 * Literal keys of one `keyof` operand: public data member names of the
 * resolved declaration, following alias indirection into literal unions.
 */
function keyOfNames(
  id: TypeNodeId,
  context: ComputedProjectionContext,
  state: ProjectionState,
): string[] | undefined {
  const node = context.renderer.node(id)
  if (node.kind === 'parenthesized') return keyOfNames(node.type, context, state)
  if (node.kind === 'union') return literalUnionMembers(node, context)
  if (node.kind !== 'reference' || node.target.kind !== 'declaration') return undefined
  const declaration = context.renderer.declaration(node.target.symbol)
  if (declaration.kind === 'alias') {
    if (declaration.type === undefined) return undefined
    return keyOfNames(declaration.type, context, state)
  }
  return declaration.members
    .filter(member => member.visibility === 'public' && !member.static && member.kind !== 'index')
    .map(member => member.name)
}

/** String literals of one union node, undefined when any member is not a string literal. */
function literalUnionMembers(
  node: Extract<TypeNodeModel, { kind: 'union' | 'intersection' }>,
  context: ComputedProjectionContext,
): string[] | undefined {
  const names: string[] = []
  for (const member of node.types) {
    const memberNode = context.renderer.node(member)
    if (memberNode.kind !== 'literal' || typeof memberNode.value !== 'string') return undefined
    names.push(memberNode.value)
  }
  return names
}

/**
 * Project `O[I]`: the union of `O`'s member schemas selected by the literal
 * keys `I` evaluates to. A type-parameter index reads its mapped key; an
 * object that is itself a mapped alias evaluates per key.
 */
function indexedAccessSchema(
  node: Extract<TypeNodeModel, { kind: 'indexed-access' }>,
  context: ComputedProjectionContext,
  state: ProjectionState,
): string | undefined {
  const selected = indexKeys(node.index, context, state)
  if (selected === undefined) return undefined
  const mapped = mappedTarget(node.object, context, state)
  if (mapped !== undefined) {
    const schemas = selected.map(key => mappedValueSchema(mapped, key, context, state))
    if (schemas.length === 0) return 'z.never()'
    if (schemas.length === 1) return schemas[0]
    return `z.union([${schemas.join(', ')}])`
  }
  const members = membersOf(context.renderer.node(node.object), context, state)
  if (members === undefined) return undefined
  const schemas: string[] = []
  for (const key of selected) {
    const member = members.find(candidate => candidate.name === key)
    if (member === undefined || member.kind !== 'property') return undefined
    const schema = context.schema(member.type, state.substitutions, state.keys)
    schemas.push(member.optional ? `${schema}.optional()` : schema)
  }
  if (schemas.length === 0) return 'z.never()'
  if (schemas.length === 1) return schemas[0]
  return `z.union([${schemas.join(', ')}])`
}

/** Resolve one node to a mapped node, following alias declarations. */
function mappedTarget(
  id: TypeNodeId,
  context: ComputedProjectionContext,
  state: ProjectionState,
): Extract<TypeNodeModel, { kind: 'mapped' }> | undefined {
  const node = context.renderer.node(id)
  if (node.kind === 'mapped') return node
  if (node.kind === 'parenthesized') return mappedTarget(node.type, context, state)
  if (node.kind === 'reference' && node.target.kind === 'declaration') {
    const declaration = context.renderer.declaration(node.target.symbol)
    if (declaration.kind === 'alias' && declaration.type !== undefined) {
      return mappedTarget(declaration.type, context, state)
    }
  }
  return undefined
}

/** Value schema of one mapped member: the mapped value with its parameter bound to the key. */
function mappedValueSchema(
  node: Extract<TypeNodeModel, { kind: 'mapped' }>,
  key: string,
  context: ComputedProjectionContext,
  state: ProjectionState,
): string {
  if (node.value === undefined) {
    context.fail(node.id, 'mapped type has no value projection')
  }
  return context.schema(node.value, mappedSubstitutions(node, key, state), mappedKeys(node, key, state))
}

function mappedSubstitutions(
  node: Extract<TypeNodeModel, { kind: 'mapped' }>,
  key: string,
  state: ProjectionState,
): ReadonlyMap<string, string> {
  const nested = new Map(state.substitutions)
  nested.set(node.parameter.id, `z.literal(${quoteKey(key)})`)
  return nested
}

function mappedKeys(
  node: Extract<TypeNodeModel, { kind: 'mapped' }>,
  key: string,
  state: ProjectionState,
): ReadonlyMap<string, string> {
  const nested = new Map(state.keys)
  nested.set(node.parameter.id, key)
  return nested
}

/** Literal keys one index node denotes: a literal, a keyof, an alias, a union, or a mapped key. */
function indexKeys(
  id: TypeNodeId,
  context: ComputedProjectionContext,
  state: ProjectionState,
): string[] | undefined {
  const node = context.renderer.node(id)
  if (node.kind === 'literal' && typeof node.value === 'string') return [node.value]
  if (node.kind === 'parenthesized') return indexKeys(node.type, context, state)
  if (node.kind === 'reference' && node.target.kind === 'type-parameter') {
    const key = state.keys.get(node.target.parameter)
    return key === undefined ? undefined : [key]
  }
  if (node.kind === 'operator' && node.operator === 'keyof') {
    return keyOfNames(node.type, context, state)
  }
  if (node.kind === 'reference' && node.target.kind === 'declaration') {
    const declaration = context.renderer.declaration(node.target.symbol)
    if (declaration.kind !== 'alias' || declaration.type === undefined) return undefined
    return indexKeys(declaration.type, context, state)
  }
  if (node.kind === 'union') {
    const names: string[] = []
    for (const member of node.types) {
      const memberKeys = indexKeys(member, context, state)
      if (memberKeys === undefined) return undefined
      names.push(...memberKeys)
    }
    return names
  }
  return undefined
}

/** Data members of one object-ish node: inline members or a declaration's. */
function membersOf(
  node: TypeNodeModel,
  context: ComputedProjectionContext,
  state: ProjectionState,
): readonly MemberModel[] | undefined {
  if (node.kind === 'object') return node.members
  if (node.kind === 'parenthesized') return membersOf(context.renderer.node(node.type), context, state)
  if (node.kind === 'reference' && node.target.kind === 'declaration') {
    const declaration: TypeDeclarationModel = context.renderer.declaration(node.target.symbol)
    if (declaration.kind === 'alias') {
      if (declaration.type === undefined) return undefined
      return membersOf(context.renderer.node(declaration.type), context, state)
    }
    return declaration.members.filter(member => member.visibility === 'public' && !member.static)
  }
  return undefined
}

/**
 * Project `{ [K in Constraint]: Value }` as an object with one property per
 * constraint key, each holding the value schema with `K` bound to that key.
 */
function mappedSchema(
  node: Extract<TypeNodeModel, { kind: 'mapped' }>,
  context: ComputedProjectionContext,
  state: ProjectionState,
): string | undefined {
  if (node.nameType !== undefined) return undefined
  if (node.parameter.constraint === undefined) return undefined
  if (node.value === undefined) return undefined
  const names = indexKeys(node.parameter.constraint, context, state)
  if (names === undefined) return undefined
  const properties = names.map(name =>
    `  ${quoteKey(name)}${node.optional === 'add' ? '?' : ''}: ${mappedValueSchema(node, name, context, state)},`)
  return `z.object({${properties.length === 0 ? '' : `\n${properties.join('\n')}\n`}})`
}

function quoteKey(name: string): string {
  return `'${name.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}
