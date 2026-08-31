/**
 * Zod schema emission for one modeled package: declaration definitions,
 * schema exports, and Remote codec boundary schemas.
 */

import type {
  DocumentationModel,
  MemberModel,
  SchemaModel,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
} from './model.ts'
import { TypeGraphRenderer } from './renderer.ts'
import { computedSchema } from './computed-projection.ts'
import { TypertEmitError } from './emitter.ts'
import { quote, safeIdentifier, uniqueName } from './emitter-text.ts'
import { indexedAccessTargets } from './schema-indexed.ts'

interface SchemaExport {
  readonly model: SchemaModel
  readonly exportName: string
  readonly internalName: string
}

/** Zod definitions, schema exports, and boundary codecs for one package. */
export interface SchemaArtifact {
  readonly definitions: readonly string[]
  readonly exports: readonly SchemaExport[]
  boundary(key: string): string
}

/** One Remote codec schema root keyed by its invocation boundary. */
export interface BoundarySchemaRoot {
  readonly key: string
  readonly type: TypeNodeId
}

/** Schema-expression substitution for one generic parameter id. */
type Substitutions = ReadonlyMap<string, string>

/** Generated name of the parameterized-schema memo; `$schema` suffixes keep declaration names clear of it. */
const MEMOIZE_NAME = 'memoize$'

/**
 * Definition of the generated memo: one instance per argument-schema tuple,
 * looked up through a Map chain so argument identity, not order of arrival,
 * decides reuse.
 */
const MEMOIZE_DEFINITION = `const ${MEMOIZE_NAME} = (build) => {
  const root = new Map()
  const held = Symbol('held')
  return (...args) => {
    let node = root
    for (const argument of args) {
      let next = node.get(argument)
      if (next === undefined) {
        next = new Map()
        node.set(argument, next)
      }
      node = next
    }
    if (!node.has(held)) node.set(held, build(...args))
    return node.get(held)
  }
}`

/** Emit Zod definitions and codec boundaries from a rendered type graph. */
export class SchemaEmitter {
  private readonly names = new Map<SymbolId, string>()
  private readonly boundaryNames = new Map<string, string>()
  private readonly declarations: TypeDeclarationModel[]
  private readonly hoistedArguments = new Map<string, string>()
  private readonly identifiers = new Set<string>()
  /** Parameter bindings of the declaration currently being emitted. */
  private parameterNames: readonly string[] = []
  /** Declaration currently being emitted, whose self-references are cycles. */
  private emitting: SymbolId | undefined

  constructor(
    private readonly renderer: TypeGraphRenderer,
    private readonly schemas: readonly SchemaModel[],
    private readonly boundaries: readonly BoundarySchemaRoot[],
  ) {
    const declarations = new Map<SymbolId, TypeDeclarationModel>()
    for (const schema of schemas) {
      for (const declaration of renderer.declarationClosureForTypes([schema.type])) {
        declarations.set(declaration.id, declaration)
      }
    }
    for (const boundary of boundaries) {
      for (const declaration of renderer.declarationClosureForTypes([boundary.type])) {
        declarations.set(declaration.id, declaration)
      }
    }
    this.declarations = renderer.graph.declarations.filter(declaration => declarations.has(declaration.id))
    const identifiers = this.identifiers
    for (const declaration of this.declarations) {
      this.names.set(declaration.id, uniqueName(`${safeIdentifier(declaration.name)}$schema`, identifiers))
    }
    for (const boundary of boundaries) {
      this.boundaryNames.set(boundary.key, uniqueName(`${safeIdentifier(boundary.key)}$schema`, identifiers))
    }
  }

  /**
   * Emit the schema module for the declarations and boundaries this emitter
   * was constructed with.
   * @returns the definitions, the exported schema names, and a lookup from
   *   boundary key to its generated name.
   */
  emit(): SchemaArtifact {
    const definitions = this.declarations.map(declaration => this.declarationDefinition(declaration))
    if (this.declarations.some(declaration => declaration.typeParameters.length > 0)) {
      definitions.unshift(MEMOIZE_DEFINITION)
    }
    for (const boundary of this.boundaries) {
      definitions.push(`const ${this.boundaryName(boundary.key)} = ${this.typeSchema(boundary.type)}`)
    }
    // Emitted last, and after every declaration that names one: each is only
    // ever read inside a `z.lazy` body, so a binding declared below its use is
    // still initialized by the time anything evaluates it.
    for (const [argument, name] of this.hoistedArguments) {
      definitions.push(`const ${name} = ${argument}`)
    }
    const exports = this.schemas.map((model): SchemaExport => ({
      model,
      exportName: safeIdentifier(model.export.name),
      internalName: this.exportSchemaName(model),
    }))
    return {
      definitions,
      exports,
      boundary: key => this.boundaryName(key),
    }
  }

  private declarationDefinition(declaration: TypeDeclarationModel): string {
    const name = this.schemaName(declaration.id)
    if (declaration.typeParameters.length === 0) {
      return `const ${name} = ${this.declarationSchema(declaration, new Map())}`
    }
    // Allocated from the same set as every other generated name: a declaration
    // called `type0` would otherwise be given `type0$schema` too, and the
    // parameter would silently shadow it inside this factory.
    const parameters = declaration.typeParameters.map((parameter, index) =>
      [uniqueName(`type${String(index)}$schema`, this.identifiers), parameter.id] as const)
    const substitutions = new Map(parameters.map(([schema, id]) => [id, schema]))
    this.parameterNames = parameters.map(([schema]) => schema)
    this.emitting = declaration.id
    // Memoized on the argument schemas: a recursive generic reaches itself
    // through `z.lazy`, and rebuilding a distinct instance per dereference
    // gives Zod's recursion check nothing to recognize, so it descends forever.
    const body = this.declarationSchema(declaration, substitutions)
    this.parameterNames = []
    this.emitting = undefined
    return `const ${name} = ${MEMOIZE_NAME}((${parameters.map(([schema]) => schema).join(', ')}) => ${body})`
  }

  private declarationSchema(
    declaration: TypeDeclarationModel,
    substitutions: Substitutions,
  ): string {
    if (declaration.kind === 'enum') {
      this.fail(declaration.name, 'enum declarations have no Zod projection')
    }
    if (declaration.kind === 'alias') {
      if (declaration.type === undefined) this.fail(declaration.name, 'alias has no modeled type')
      return this.describe(this.typeSchema(declaration.type, substitutions), declaration)
    }
    const own = this.objectSchema(declaration.members, declaration.name, substitutions)
    let result = own
    for (const heritage of declaration.extends) {
      result = `z.intersection(${this.typeSchema(heritage, substitutions)}, ${result})`
    }
    return this.describe(result, declaration)
  }

  private readonly typeChain: TypeNodeId[] = []

  private typeSchema(
    id: TypeNodeId,
    substitutions: Substitutions = new Map(),
    keys: ReadonlyMap<string, string> = new Map(),
  ): string {
    const node = this.renderer.node(id)
    const chainIndex = this.typeChain.indexOf(id)
    if (chainIndex >= 0) {
      this.fail(node.kind === 'reference' ? node.name : node.kind, `cyclic type node ${id} via ${[...this.typeChain.slice(chainIndex), id].join(' > ')}`)
    }
    this.typeChain.push(id)
    const schema = this.typeSchemaBody(node, substitutions, id, keys)
    this.typeChain.pop()
    return schema
  }

  private typeSchemaBody(
    node: TypeNodeModel,
    substitutions: Substitutions,
    id: TypeNodeId,
    keys: ReadonlyMap<string, string>,
  ): string {
    switch (node.kind) {
      case 'keyword': return this.keywordSchema(node.name)
      case 'literal': return `z.literal(${node.text})`
      case 'parenthesized': return this.typeSchema(node.type, substitutions)
      case 'reference': return this.referenceSchema(node, substitutions)
      case 'union': {
        if (node.types.length === 0) return 'z.never()'
        if (node.types.length === 1) return this.typeSchema(node.types[0] as TypeNodeId, substitutions)
        return `z.union([${node.types.map(type => this.typeSchema(type, substitutions)).join(', ')}])`
      }
      case 'intersection': {
        const [head, ...tail] = node.types
        if (head === undefined) return 'z.unknown()'
        return tail.reduce(
          (left, right) => `z.intersection(${left}, ${this.typeSchema(right, substitutions)})`,
          this.typeSchema(head, substitutions),
        )
      }
      case 'array': return `z.array(${this.typeSchema(node.element, substitutions)})`
      case 'tuple': {
        const fixed = node.elements.filter(element => !element.rest)
        const rest = node.elements.find(element => element.rest)
        let schema = `z.tuple([${fixed.map(element => this.optional(this.typeSchema(element.type, substitutions), element.optional)).join(', ')}])`
        if (rest !== undefined) schema += `.rest(${this.tupleRestSchema(rest.type, substitutions)})`
        return schema
      }
      case 'object': return this.objectSchema(node.members, id, substitutions)
      case 'indexed-access': {
        const resolved = indexedAccessTargets(this.renderer, node)
        if (resolved === undefined) {
          const computed = this.computed(node, substitutions, keys)
          return computed ?? this.unsupported(node)
        }
        const targets = resolved.kind === 'single' ? [resolved.type] : resolved.types
        if (targets.some(t => this.typeChain.includes(t))) return this.unsupported(node)
        if (targets.length === 1) return this.typeSchema(targets[0] as TypeNodeId, substitutions, keys)
        return `z.union([${targets.map(t => this.typeSchema(t, substitutions, keys)).join(', ')}])`
      }
      case 'operator':
      case 'mapped': {
        const computed = this.computed(node, substitutions, keys)
        return computed ?? this.unsupported(node)
      }
      case 'infer':
      case 'template-literal':
      case 'conditional':
      case 'type-query':
      case 'import-type':
      case 'predicate':
      case 'function':
      case 'constructor':
      case 'this': return this.unsupported(node)
    }
  }

  private referenceSchema(
    node: Extract<TypeNodeModel, { kind: 'reference' }>,
    substitutions: Substitutions,
  ): string {
    if (node.target.kind === 'declaration') {
      const name = this.schemaName(node.target.symbol)
      const declaration = this.renderer.declaration(node.target.symbol)
      if (declaration.typeParameters.length === 0) {
        if (node.arguments.length > 0) {
          this.fail(node.name, `non-generic declaration received ${String(node.arguments.length)} type arguments`)
        }
        return `z.lazy(() => ${name})`
      }
      const rendered = this.declarationArguments(node, declaration, substitutions)
      // A declaration referring to itself with an argument BUILT from its own
      // parameter — `Rec<V>` whose member is `Rec<V[]>` — names a different
      // instantiation at every level, so the chain has no fixed point and no
      // memo can close it. TypeScript admits the type; a finite schema for it
      // does not exist, and emitting one that overflows at parse would hide
      // that.
      if (node.target.symbol === this.emitting) {
        for (const argument of rendered) {
          if (this.readsParameter(argument) && !this.parameterNames.includes(argument)) {
            this.fail(node.name, `recursive reference instantiates itself with ${argument}, which has no finite schema`)
          }
        }
      }
      const arguments_ = rendered.map(argument => this.stableArgument(argument))
      return `z.lazy(() => ${name}(${arguments_.join(', ')}))`
    }
    if (node.target.kind === 'type-parameter') {
      if (node.arguments.length > 0) this.fail(node.name, 'type parameter reference cannot receive type arguments')
      const schema = substitutions.get(node.target.parameter)
      if (schema === undefined) this.fail(node.name, 'type parameter has no schema substitution')
      return schema
    }
    if (node.target.kind === 'standard') {
      switch (node.target.name) {
        case 'Array':
        case 'ReadonlyArray': {
          const element = node.arguments[0]
          if (element === undefined) this.fail(node.name, 'array reference has no element type')
          return this.readonly(
            `z.array(${this.typeSchema(element, substitutions)})`,
            node.target.name === 'ReadonlyArray',
          )
        }
        case 'Record': {
          const key = node.arguments[0]
          const value = node.arguments[1]
          if (key === undefined || value === undefined) this.fail(node.name, 'Record requires key and value types')
          return `z.record(${this.typeSchema(key, substitutions)}, ${this.typeSchema(value, substitutions)})`
        }
        case 'Date': return 'z.date()'
        default: this.fail(node.name, `standard type ${node.target.name} has no Zod projection`)
      }
    }
    this.fail(node.name, `${node.target.kind} reference has no Zod projection`)
  }

  /**
   * Name one instantiation argument so the same argument is the same object.
   *
   * The memo recognizes an instantiation by the identity of its arguments, and
   * a self-reference carrying a written-out argument (`Self<string>` inside
   * `Self<T>`) evaluates that expression again on every dereference, producing
   * a new schema each time and a tower the memo never closes. An argument that
   * does not read a type parameter is constant, so it is emitted once as a
   * module binding and referred to by name. A bare parameter reference is
   * already stable, being whatever schema the caller passed in; an argument
   * built from a parameter is rejected before reaching here when it makes a
   * self-reference expand forever.
   * @param argument - rendered argument expression.
   * @returns an expression whose value is stable across evaluations.
   */
  /**
   * Whether an argument expression reads a parameter of the enclosing factory.
   *
   * The names are the ones allocated for this declaration, matched whole, so a
   * declaration whose own schema is called `type0$schema` cannot be mistaken
   * for a parameter and a parameter cannot be missed.
   * @param argument - rendered argument expression.
   * @returns true when a parameter binding appears in it.
   */
  private readsParameter(argument: string): boolean {
    return this.parameterNames.some(name =>
      new RegExp(`(?<![\\w$])${name.replace('$', '\\$')}(?![\\w$])`).test(argument))
  }

  private stableArgument(argument: string): string {
    if (this.readsParameter(argument)) return argument
    const existing = this.hoistedArguments.get(argument)
    if (existing !== undefined) return existing
    const name = uniqueName(`argument${String(this.hoistedArguments.size)}$schema`, this.identifiers)
    this.hoistedArguments.set(argument, name)
    return name
  }

  private declarationArguments(
    node: Extract<TypeNodeModel, { kind: 'reference' }>,
    declaration: TypeDeclarationModel,
    substitutions: Substitutions,
  ): string[] {
    if (node.arguments.length > declaration.typeParameters.length) {
      this.fail(
        node.name,
        `generic declaration accepts ${String(declaration.typeParameters.length)} type arguments but received ${String(node.arguments.length)}`,
      )
    }
    const resolved = new Map(substitutions)
    const arguments_: string[] = []
    for (const [index, parameter] of declaration.typeParameters.entries()) {
      const argument = node.arguments[index]
      const schema = argument === undefined
        ? parameter.default === undefined
          ? this.fail(node.name, `missing type argument ${parameter.name}`)
          : this.typeSchema(parameter.default, resolved)
        : this.typeSchema(argument, substitutions)
      arguments_.push(schema)
      resolved.set(parameter.id, schema)
    }
    return arguments_
  }

  private tupleRestSchema(id: TypeNodeId, substitutions: Substitutions): string {
    const node = this.renderer.node(id)
    if (node.kind === 'array') return this.typeSchema(node.element, substitutions)
    if (node.kind === 'reference'
      && node.target.kind === 'standard'
      && (node.target.name === 'Array' || node.target.name === 'ReadonlyArray')) {
      const element = node.arguments[0]
      if (element === undefined) this.fail(node.name, 'tuple rest array has no element type')
      return this.typeSchema(element, substitutions)
    }
    this.fail(id, 'tuple rest element must retain an array type')
  }

  private objectSchema(
    members: readonly MemberModel[],
    subject: string,
    substitutions: Substitutions,
  ): string {
    const properties: string[] = []
    const indices: string[] = []
    let symbolMembers = 0
    for (const member of members) {
      if (member.static || member.visibility !== 'public') continue
      if (member.computed === 'symbol') {
        symbolMembers++
        continue
      }
      if (member.computed === 'dynamic') {
        this.fail(subject, `computed member ${member.name} has no fixed JSON property name`)
      }
      if (member.kind === 'index') {
        const parameter = member.signature.parameters[0]
        if (member.signature.parameters.length !== 1 || parameter === undefined) {
          this.fail(subject, 'index signature must have exactly one key parameter')
        }
        indices.push(this.readonly(
          `z.record(${this.typeSchema(parameter.type, substitutions)}, ${this.typeSchema(member.signature.returns, substitutions)})`,
          member.readonly,
        ))
        continue
      }
      if (member.kind !== 'property') this.fail(subject, `${member.kind} member ${member.name} is not data-schema projectable`)
      const property = this.describe(
        this.optional(this.readonly(this.typeSchema(member.type, substitutions), member.readonly), member.optional),
        member,
      )
      properties.push(`${quote(member.jsonName ?? member.name)}: ${property}`)
    }
    if (indices.length > 1) this.fail(subject, 'object type has more than one JSON index signature')
    // A unique-symbol-only object is a compile-time marker and imposes no JSON shape.
    if (properties.length === 0 && indices.length === 0 && symbolMembers > 0) return 'z.unknown()'
    const object = `z.object({${properties.length === 0 ? '' : `\n${properties.map(property => `  ${property},`).join('\n')}\n`}})`
    const index = indices[0]
    if (index === undefined) return object
    if (properties.length === 0) return index
    return `z.intersection(${object}, ${index})`
  }

  private exportSchemaName(model: SchemaModel): string {
    const name = this.schemaName(model.symbol)
    const declaration = this.renderer.declaration(model.symbol)
    if (declaration.typeParameters.length > 0) {
      this.fail(model.export.name, 'generic schema exports require a concrete declaration')
    }
    return name
  }

  private keywordSchema(name: string): string {
    switch (name) {
      case 'any': return 'z.any()'
      case 'unknown': return 'z.unknown()'
      case 'never': return 'z.never()'
      case 'string': return 'z.string()'
      case 'number': return 'z.number()'
      case 'bigint': return 'z.bigint()'
      case 'boolean': return 'z.boolean()'
      case 'symbol': return 'z.symbol()'
      case 'undefined': return 'z.undefined()'
      case 'void': return 'z.void()'
      case 'object': return "z.custom((value) => (typeof value === 'object' && value !== null) || typeof value === 'function')"
      default: this.fail(name, `keyword ${name} has no Zod projection`)
    }
  }

  private schemaName(symbol: SymbolId): string {
    const name = this.names.get(symbol)
    if (name === undefined) this.fail(symbol, 'referenced declaration is outside the selected schema closure')
    return name
  }

  private boundaryName(key: string): string {
    const name = this.boundaryNames.get(key)
    if (name === undefined) this.fail(key, 'invocation boundary is outside the selected schema roots')
    return name
  }

  private describe(schema: string, documentation: DocumentationModel): string {
    return documentation.description === undefined ? schema : `${schema}.describe(${quote(documentation.description)})`
  }

  private optional(schema: string, optional: boolean): string {
    return optional ? `${schema}.optional()` : schema
  }

  private readonly(schema: string, readonly: boolean): string {
    return readonly ? `${schema}.readonly()` : schema
  }

  private computed(
    node: TypeNodeModel,
    substitutions: Substitutions,
    keys: ReadonlyMap<string, string>,
  ): string | undefined {
    return computedSchema(node, {
      renderer: this.renderer,
      schema: (id, sub, k) => this.typeSchema(id, sub, k),
      fail: (subject, message) => this.fail(subject, message),
    }, { substitutions, keys })
  }

  private unsupported(node: TypeNodeModel): never { this.fail(node.id, `type node ${node.kind} has no Zod projection`) }
  private fail(subject: string, message: string): never { throw new TypertEmitError(`typert Zod emitter: ${subject}: ${message}`) }
}
