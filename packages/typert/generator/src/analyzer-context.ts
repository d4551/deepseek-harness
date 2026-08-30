/**
 * Mutable extraction state for one Typert face. Large walks live as functions
 * that take this context; this class owns identity, locations, and edits.
 */

import { relative } from 'node:path'
import type { Node, SourceFile, TypeNode } from 'typescript/unstable/ast'
import { isTypeReferenceNode } from 'typescript/unstable/ast/is'
import type { Checker, Symbol, Type } from 'typescript/unstable/sync'
import { NodeBuilderFlags, SymbolFlags } from 'typescript/unstable/sync'
import type { AnalysisMode, SourceEdit } from './analyzer-error.ts'
import { TypertAnalysisError } from './analyzer-error.ts'
import { packageExportTargets, sourcePathForExport } from './analyzer-exports.ts'
import { annotationPosition } from './analyzer-literals.ts'
import type { StaticMapEntry } from './analyzer-remote-types.ts'
import type { PackageRegistration } from './analyzer-types.ts'
import { realPath, slash } from './analyzer-util.ts'
import type {
  CrossFaceLink,
  ExportModel,
  SourceLocation,
  SymbolId,
  TypeDeclarationModel,
  TypeNodeId,
  TypeNodeModel,
  TypertFace,
} from './model.ts'
import type { FaceProject } from './ts7-project.ts'
import { preferredDeclaration } from './ts7-syntax.ts'

export interface ExportRecord {
  readonly model: ExportModel
  readonly symbol: Symbol
  readonly declaration: Node
  readonly sourceFile: SourceFile
}

export interface FaceAnalyzerOptions {
  readonly root: string
  readonly face: TypertFace
  readonly project: FaceProject
  readonly registrations: readonly PackageRegistration[]
  readonly allRegistrations: readonly PackageRegistration[]
  readonly mode: AnalysisMode
  readonly crossFaceLinks: Map<string, CrossFaceLink>
}

type WithoutId<T> = T extends { readonly id: TypeNodeId } ? Omit<T, 'id'> : never
export type TypeNodeInput = WithoutId<TypeNodeModel>

/** One face's TypeScript 7 project plus extraction tables. */
export class FaceContext {
  readonly root: string
  readonly face: TypertFace
  readonly project: FaceProject
  readonly checker: Checker
  readonly registrations: readonly PackageRegistration[]
  readonly allRegistrations: readonly PackageRegistration[]
  readonly mode: AnalysisMode
  readonly crossFaceLinks: Map<string, CrossFaceLink>
  readonly sourceFiles = new Map<string, SourceFile>()
  readonly declarations = new Map<SymbolId, TypeDeclarationModel>()
  readonly declarationStates = new Set<SymbolId>()
  readonly nodes = new Map<TypeNodeId, TypeNodeModel>()
  readonly exportsByPackage = new Map<string, ExportRecord[]>()
  readonly nodeOrdinals = new Map<string, number>()
  lookups: readonly StaticMapEntry[] | undefined
  contexts: ReadonlyMap<string, StaticMapEntry> | undefined
  queuedEdit: SourceEdit | undefined

  constructor(options: FaceAnalyzerOptions) {
    this.root = options.root
    this.face = options.face
    this.project = options.project
    this.checker = options.project.checker
    this.registrations = options.registrations
    this.allRegistrations = options.allRegistrations
    this.mode = options.mode
    this.crossFaceLinks = options.crossFaceLinks
    for (const sourceFile of this.project.sourceFiles()) {
      this.sourceFiles.set(realPath(sourceFile.fileName), sourceFile)
    }
  }

  resolveSymbol(symbol: Symbol): Symbol {
    return (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : this.checker.getAliasedSymbol(symbol)
  }

  symbolId(symbol: Symbol): SymbolId {
    const resolved = this.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved, this.project.project)
    const file = declaration === undefined ? resolved.name : declaration.getSourceFile().fileName
    return `${slash(file)}#${resolved.name}`
  }

  registrationForFile(file: string): PackageRegistration | undefined {
    const path = realPath(file)
    return this.registrations.find(registration => path === registration.root || path.startsWith(`${registration.root}/`))
      ?? this.allRegistrations.find(registration =>
        registration.face === this.face && (path === registration.root || path.startsWith(`${registration.root}/`)))
  }

  location(node: Node): SourceLocation {
    const sourceFile = node.getSourceFile()
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return {
      file: slash(relative(this.root, sourceFile.fileName)),
      line: position.line + 1,
      column: position.character + 1,
    }
  }

  locationKey(node: Node): string {
    const location = this.location(node)
    return `${location.file}:${String(location.line)}:${String(location.column)}`
  }

  allocateNodeId(site: Node): TypeNodeId {
    const key = this.locationKey(site)
    const ordinal = this.nodeOrdinals.get(key) ?? 0
    this.nodeOrdinals.set(key, ordinal + 1)
    return `${key}#${String(ordinal)}`
  }

  addNode(site: Node, model: TypeNodeInput): TypeNodeId {
    const id = this.allocateNodeId(site)
    this.nodes.set(id, { id, ...model })
    return id
  }

  fail(node: Node, message: string): never {
    const location = this.location(node)
    throw new TypertAnalysisError(
      `typert(${this.face}): ${location.file}:${String(location.line)}:${String(location.column)}: ${message}`,
    )
  }

  print(node: Node): string {
    return this.project.printNode(node)
  }

  symbolAtType(node: TypeNode): Symbol | undefined {
    if (isTypeReferenceNode(node)) {
      const symbol = this.checker.getSymbolAtLocation(node.typeName)
      return symbol === undefined ? undefined : this.resolveSymbol(symbol)
    }
    const type = this.checker.getTypeAtLocation(node)
    if (type === undefined) return undefined
    const symbol = type.getAliasSymbol() ?? type.getSymbol()
    return symbol === undefined ? undefined : this.resolveSymbol(symbol)
  }

  referenceNode(symbol: Symbol, site: Node): TypeNodeId {
    return this.addNode(site, {
      kind: 'reference',
      name: symbol.name,
      target: { kind: 'declaration', symbol: this.symbolId(symbol) },
      arguments: [],
    })
  }

  requiredType(owner: Node, type: TypeNode | undefined, purpose: 'property' | 'parameter' | 'return'): TypeNode {
    if (type !== undefined) return type
    if (this.mode === 'check') this.fail(owner, `public ${purpose} is missing an explicit type annotation`)
    const inferred = this.inferType(owner, purpose)
    if (this.queuedEdit === undefined) {
      this.queuedEdit = {
        file: realPath(owner.getSourceFile().fileName),
        position: annotationPosition(owner, purpose),
        text: `: ${this.print(inferred)}`,
      }
    }
    return inferred
  }

  inferType(owner: Node, purpose: 'property' | 'parameter' | 'return'): TypeNode {
    if (purpose === 'return') {
      const signature = this.checker.getSignatureFromDeclaration(owner)
      if (signature === undefined) this.fail(owner, 'public return is missing a signature')
      const type = this.checker.getReturnTypeOfSignature(signature)
      if (type === undefined) this.fail(owner, 'public return is missing a type')
      return this.typeNodeOf(type, owner, 'cannot infer return type node')
    }
    const type = this.checker.getTypeAtLocation(owner)
    if (type === undefined) this.fail(owner, `public ${purpose} is missing a type`)
    return this.typeNodeOf(type, owner, `cannot infer ${purpose} type node`)
  }

  typeNodeOf(type: Type, owner: Node, message: string): TypeNode {
    const node = this.checker.typeToTypeNode(
      type,
      owner,
      NodeBuilderFlags.NoTruncation | NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
    )
    if (node === undefined) this.fail(owner, message)
    return node
  }

  packageExportName(
    module: { readonly package: string; readonly subpath: string },
    symbol: Symbol,
    face: TypertFace,
    requestedName: string,
  ): string | undefined {
    const registration = this.allRegistrations.find(candidate =>
      candidate.face === face && candidate.name === module.package)
    if (registration === undefined) return undefined
    const target = packageExportTargets(registration.manifest)
      .find(([subpath]) => subpath === module.subpath)?.[1]
    if (target === undefined) return undefined
    const sourceFile = this.sourceFiles.get(realPath(sourcePathForExport(registration.root, target)))
    if (sourceFile === undefined) return undefined
    const moduleSymbol = this.checker.getSymbolAtLocation(sourceFile)
    if (moduleSymbol === undefined) return undefined
    const exported = this.checker.getExportsOfModule(moduleSymbol)
      .find(candidate => candidate.name === requestedName
        && this.symbolId(this.resolveSymbol(candidate)) === this.symbolId(this.resolveSymbol(symbol)))
    return exported?.name
  }

  recordCrossFaceLink(
    fromPackage: string,
    toFace: TypertFace,
    module: { readonly package: string; readonly subpath: string },
    name: string,
  ) {
    const link = {
      fromFace: this.face,
      fromPackage,
      toFace,
      toPackage: module.package,
      subpath: module.subpath,
      name,
    }
    this.crossFaceLinks.set([
      link.fromFace, link.fromPackage, link.toFace, link.toPackage, link.subpath, link.name,
    ].join('\0'), link)
  }
}
