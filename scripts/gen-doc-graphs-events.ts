/**
 * Program-backed event dispatcher/listener collection for documentation graphs.
 */

import type {
  CallExpression, ClassDeclaration, Expression, FunctionDeclaration, Identifier, InterfaceDeclaration,
  Node, NoSubstitutionTemplateLiteral, ParameterDeclaration, SourceFile, StringLiteral,
} from 'typescript/unstable/ast'
import {
  isArrayLiteralExpression,
  isCallExpression,
  isClassDeclaration,
  isConditionalExpression,
  isFunctionDeclaration,
  isIdentifier,
  isInterfaceDeclaration,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isOmittedExpression,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isShorthandPropertyAssignment,
  isSpreadElement,
  isStringLiteral,
  isVariableDeclaration,
} from 'typescript/unstable/ast/is'
import { SymbolFlags, TypeFlags, type Type } from 'typescript/unstable/sync'
import {
  addAll,
  finiteStringTypeValues,
  hasExportModifier,
  isConstDeclaration,
  isDirectCallee,
  unionSets,
  unwrapExpression,
} from './gen-doc-graphs-event-syntax.ts'
import { TypeScriptProject } from './ts-project.ts'

/** One scanned package source file and its owning package short name. */
export interface PackageSource {
  rel: string
  pkg: string
  sourceFile: SourceFile
}

interface EventRelation {
  dispatchers: Map<string, Set<string>>
  listeners: Set<string>
}

type EventReceiverKind = 'context' | 'agent-dispatch' | 'events-service'
type CallSiteIndex = Map<Node, CallExpression[]>

const EVENT_API_METHODS = new Set(['on', 'once', 'emit', 'parallel', 'serial', 'waterfall', 'dispatch'])

function isStringLiteralLike(node: Node): node is StringLiteral | NoSubstitutionTemplateLiteral {
  return isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)
}

/**
 * Collect event dispatch/listener relations from real cross-file receiver types.
 *
 * The program is seeded from the host aggregate alone, so a Client package
 * enters only when a host file imports it.
 */
export class EventRelationCollector {
  private readonly relations = new Map<string, EventRelation>()
  private readonly fileCallSites = new Map<SourceFile, CallSiteIndex>()
  private readonly localCalleeProofs = new Map<FunctionDeclaration, boolean>()
  private globalCallSites: CallSiteIndex | null = null
  private readonly contextType: Type
  private readonly agentDispatchType: Type
  private readonly eventsServiceType: Type
  private readonly packageSourceFiles: ReadonlySet<SourceFile>

  constructor(
    private readonly project: TypeScriptProject,
    private readonly sources: readonly PackageSource[],
  ) {
    this.contextType = this.declaredType('vendor/cordis/src/context.ts', 'Context')
    this.agentDispatchType = this.declaredType('packages/core/agent/src/dispatch.ts', 'AgentEventDispatch')
    this.eventsServiceType = this.declaredType('vendor/cordis/src/events.ts', 'EventsService')
    this.packageSourceFiles = new Set(sources.map(source => source.sourceFile))
  }

  /** Return all event relations discovered from the Program. */
  collect(): Map<string, EventRelation> {
    for (const source of this.sources) this.visitSource(source)
    return this.relations
  }

  private declaredType(relativePath: string, name: string): Type {
    const sourceFile = this.project.sourceFile(relativePath)
    const declaration = sourceFile.statements.find((statement): statement is ClassDeclaration | InterfaceDeclaration => {
      return (isClassDeclaration(statement) || isInterfaceDeclaration(statement)) && statement.name?.text === name
    })
    const symbol = declaration?.name === undefined
      ? undefined
      : this.project.checker.getSymbolAtLocation(declaration.name)
    if (symbol === undefined) throw new Error(`cannot resolve TypeScript type ${name} from ${relativePath}`)
    return this.project.checker.getDeclaredTypeOfSymbol(symbol)
  }

  private buildCallSiteIndex(files: Iterable<SourceFile>): CallSiteIndex {
    const index: CallSiteIndex = new Map()
    const visit = (node: Node): void => {
      if (isCallExpression(node)) {
        const declaration = this.project.checker.getResolvedSignature(node)?.declaration?.resolve()
        if (declaration !== undefined) {
          const calls = index.get(declaration) ?? []
          calls.push(node)
          index.set(declaration, calls)
        }
      }
      node.forEachChild(visit)
    }
    for (const file of files) visit(file)
    return index
  }

  private callSitesFor(owner: FunctionDeclaration): CallExpression[] {
    if (this.globalCallSites === null && !this.provenLocalCallee(owner)) {
      this.globalCallSites = this.buildCallSiteIndex(this.packageSourceFiles)
    }
    if (this.globalCallSites !== null) return this.globalCallSites.get(owner) ?? []
    const file = owner.getSourceFile()
    let index = this.fileCallSites.get(file)
    if (index === undefined) {
      index = this.buildCallSiteIndex([file])
      this.fileCallSites.set(file, index)
    }
    return index.get(owner) ?? []
  }

  private provenLocalCallee(owner: FunctionDeclaration): boolean {
    const cached = this.localCalleeProofs.get(owner)
    if (cached !== undefined) return cached
    if (hasExportModifier(owner) || owner.getSourceFile().externalModuleIndicator === undefined) {
      this.localCalleeProofs.set(owner, false)
      return false
    }
    const name = owner.name
    const ownerSymbol = name === undefined ? undefined : this.project.checker.getSymbolAtLocation(name)
    let proven = ownerSymbol !== undefined
    const refersToOwner = (identifier: Identifier): boolean => {
      const local = isShorthandPropertyAssignment(identifier.parent)
        ? this.project.checker.getShorthandAssignmentValueSymbol(identifier.parent)
        : this.project.checker.getSymbolAtLocation(identifier)
      if (local === undefined) return false
      const symbol = (local.flags & SymbolFlags.Alias) !== 0
        ? this.project.checker.getAliasedSymbol(local)
        : local
      return symbol === ownerSymbol
    }
    const visit = (node: Node): void => {
      if (!proven) return
      if (isIdentifier(node) && node !== name && node.text === name?.text
        && !isDirectCallee(node) && refersToOwner(node)) {
        proven = false
        return
      }
      node.forEachChild(visit)
    }
    visit(owner.getSourceFile())
    this.localCalleeProofs.set(owner, proven)
    return proven
  }

  private visitSource(source: PackageSource): void {
    const visit = (node: Node): void => {
      if (isCallExpression(node)) {
        if (this.isAgentEventEmitter(node.expression)) {
          const event = node.arguments[2]
          if (event !== undefined) {
            for (const name of this.finiteStringValues(event) ?? []) {
              this.addDispatcher(name, source.pkg, 'emitAgentEvent')
            }
          }
        } else if (isPropertyAccessExpression(node.expression) && EVENT_API_METHODS.has(node.expression.name.text)) {
          const receiverKind = this.receiverKind(node.expression.expression)
          const method = node.expression.name.text
          if (receiverKind === 'events-service' && method === 'dispatch') {
            const argumentList = node.arguments[1]
            if (argumentList !== undefined) {
              for (const event of this.eventNamesFromArgumentList(argumentList, new Set())) {
                this.addDispatcher(event, source.pkg, 'events.dispatch')
              }
            }
          } else if (receiverKind === 'context' || receiverKind === 'agent-dispatch') {
            const eventNames = this.eventNamesFromCall(node, receiverKind)
            if (method === 'on' || method === 'once') {
              for (const event of eventNames) this.ensure(event).listeners.add(source.pkg)
            } else if (method === 'emit' || method === 'parallel' || method === 'serial' || method === 'waterfall') {
              for (const event of eventNames) this.addDispatcher(event, source.pkg, method)
            }
          }
        }
      }
      node.forEachChild(visit)
    }
    visit(source.sourceFile)
  }

  private isAgentEventEmitter(expression: Expression): boolean {
    if (!isIdentifier(expression)) return false
    const local = this.project.checker.getSymbolAtLocation(expression)
    if (local === undefined) return false
    const symbol = (local.flags & SymbolFlags.Alias) !== 0 ? this.project.checker.getAliasedSymbol(local) : local
    return symbol.declarations.some((handle) => {
      const declaration = handle.resolve()
      return declaration !== undefined
        && isFunctionDeclaration(declaration)
        && declaration.name?.text === 'emitAgentEvent'
        && this.project.relativePath(declaration.getSourceFile()) === 'packages/core/agent/src/dispatch.ts'
    })
  }

  private receiverKind(receiver: Expression): EventReceiverKind | undefined {
    const type = this.project.checker.getTypeAtLocation(receiver)
    if (type === undefined) return undefined
    if ((type.flags & (TypeFlags.Any | TypeFlags.Unknown | TypeFlags.Never)) !== 0) return undefined
    if (this.project.checker.isTypeAssignableTo(type, this.eventsServiceType)) return 'events-service'
    if (this.project.checker.isTypeAssignableTo(type, this.contextType)) return 'context'
    if (this.project.checker.isTypeAssignableTo(type, this.agentDispatchType)) return 'agent-dispatch'
    return undefined
  }

  private eventNamesFromCall(call: CallExpression, receiverKind: Exclude<EventReceiverKind, 'events-service'>): Set<string> {
    const candidates = receiverKind === 'context' ? call.arguments.slice(0, 2) : call.arguments.slice(0, 1)
    for (const candidate of candidates) {
      const values = this.finiteStringValues(candidate)
      if (values !== undefined) return values
    }
    return new Set()
  }

  private eventNamesFromArgumentList(expression: Expression, seen: Set<Node>): Set<string> {
    const current = unwrapExpression(expression)
    if (seen.has(current)) return new Set()
    seen.add(current)
    if (isArrayLiteralExpression(current)) {
      for (const element of current.elements.slice(0, 2)) {
        if (isOmittedExpression(element) || isSpreadElement(element)) continue
        const values = this.finiteStringValues(element)
        if (values !== undefined) return values
      }
      return new Set()
    }
    if (isConditionalExpression(current)) {
      return unionSets(
        this.eventNamesFromArgumentList(current.whenTrue, new Set(seen)),
        this.eventNamesFromArgumentList(current.whenFalse, new Set(seen)),
      )
    }
    if (!isIdentifier(current)) return new Set()
    const symbol = this.project.checker.getSymbolAtLocation(current)
    if (symbol === undefined) return new Set()
    const events = new Set<string>()
    for (const handle of symbol.declarations) {
      const declaration = handle.resolve()
      if (declaration === undefined) continue
      if (isVariableDeclaration(declaration) && declaration.initializer !== undefined && isConstDeclaration(declaration)) {
        addAll(events, this.eventNamesFromArgumentList(declaration.initializer, new Set(seen)))
      } else if (isParameterDeclaration(declaration)) {
        addAll(events, this.eventNamesFromParameter(declaration, seen))
      }
    }
    return events
  }

  private eventNamesFromParameter(parameter: ParameterDeclaration, seen: Set<Node>): Set<string> {
    const owner = parameter.parent
    if (!isFunctionDeclaration(owner) || hasExportModifier(owner)) return new Set()
    const index = owner.parameters.indexOf(parameter)
    if (index < 0) return new Set()
    const events = new Set<string>()
    for (const call of this.callSitesFor(owner)) {
      const argument = call.arguments[index]
      if (argument !== undefined) addAll(events, this.eventNamesFromArgumentList(argument, new Set(seen)))
    }
    return events
  }

  private finiteStringValues(expression: Expression): Set<string> | undefined {
    const current = unwrapExpression(expression)
    if (isStringLiteralLike(current)) return new Set([current.text])
    if (this.isForwardedAgentEventParameter(current)) return undefined
    const type = this.project.checker.getTypeAtLocation(current)
    return type === undefined ? undefined : finiteStringTypeValues(type)
  }

  private isForwardedAgentEventParameter(expression: Expression): boolean {
    if (!isIdentifier(expression)) return false
    const handles = this.project.checker.getSymbolAtLocation(expression)?.declarations ?? []
    return handles.some((handle) => {
      const declaration = handle.resolve()
      if (declaration === undefined || !isParameterDeclaration(declaration)) return false
      const method = declaration.parent
      if (!isMethodDeclaration(method) || !isObjectLiteralExpression(method.parent)) return false
      const contextualType = this.project.checker.getContextualType(method.parent)
      return contextualType !== undefined
        && this.project.checker.isTypeAssignableTo(contextualType, this.agentDispatchType)
    })
  }

  private ensure(event: string): EventRelation {
    const existing = this.relations.get(event)
    if (existing !== undefined) return existing
    const relation = { dispatchers: new Map<string, Set<string>>(), listeners: new Set<string>() }
    this.relations.set(event, relation)
    return relation
  }

  private addDispatcher(event: string, pkg: string, method: string): void {
    const relation = this.ensure(event)
    const methods = relation.dispatchers.get(pkg) ?? new Set<string>()
    methods.add(method)
    relation.dispatchers.set(pkg, methods)
  }
}

/**
 * Select the package source files of one project in deterministic order.
 * @param project - the loaded repository TypeScript project.
 * @returns `packages/<group>/<pkg>/src` files tagged with their package name.
 */
export function collectPackageSources(project: TypeScriptProject): PackageSource[] {
  return project.sourceFiles().flatMap((sourceFile): PackageSource[] => {
    const rel = project.relativePath(sourceFile)
    const match = /^packages\/[^/]+\/([^/]+)\/src\/.+\.ts$/.exec(rel)
    return match?.[1] ? [{ rel, pkg: match[1], sourceFile }] : []
  }).sort((left, right) => left.rel.localeCompare(right.rel))
}
