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

/** One public export of a registered package, with the nodes it was read from. */
export interface ExportRecord {
  /** Extracted export model. */
  readonly model: ExportModel
  /** Resolved checker symbol behind the export. */
  readonly symbol: Symbol
  /** Declaration the model was extracted from. */
  readonly declaration: Node
  /** File the declaration lives in. */
  readonly sourceFile: SourceFile
}

/** Everything one {@link FaceContext} needs to analyze a single face. */
export interface FaceAnalyzerOptions {
  /** Repository root; source locations are recorded relative to it. */
  readonly root: string
  /** Face being analyzed. */
  readonly face: TypertFace
  /** Opened TypeScript 7 project for this face. */
  readonly project: FaceProject
  /** Packages this face analyzes. */
  readonly registrations: readonly PackageRegistration[]
  /** Packages of both faces, for cross-face resolution. */
  readonly allRegistrations: readonly PackageRegistration[]
  /** Whether a missing annotation fails or is inferred and queued as an edit. */
  readonly mode: AnalysisMode
  /** Links recorded across faces, keyed by their own fields; shared by both faces. */
  readonly crossFaceLinks: Map<string, CrossFaceLink>
}

type WithoutId<T> = T extends { readonly id: TypeNodeId } ? Omit<T, 'id'> : never
/** A type-node model as callers supply it: every field except the id the context allocates. */
export type TypeNodeInput = WithoutId<TypeNodeModel>

/** One face's TypeScript 7 project plus extraction tables. */
export class FaceContext {
  /** Repository root; source locations are recorded relative to it. */
  readonly root: string
  /** Face being analyzed. */
  readonly face: TypertFace
  /** Opened TypeScript 7 project for this face. */
  readonly project: FaceProject
  /** The project's checker. */
  readonly checker: Checker
  /** Packages this face analyzes. */
  readonly registrations: readonly PackageRegistration[]
  /** Packages of both faces, for cross-face resolution. */
  readonly allRegistrations: readonly PackageRegistration[]
  /** Whether a missing annotation fails or is inferred and queued as an edit. */
  readonly mode: AnalysisMode
  /** Links recorded across faces, keyed by their own fields; shared by both faces. */
  readonly crossFaceLinks: Map<string, CrossFaceLink>
  /** Program source files by real path. */
  readonly sourceFiles = new Map<string, SourceFile>()
  /** Extracted declarations by symbol id. */
  readonly declarations = new Map<SymbolId, TypeDeclarationModel>()
  /** Symbols whose declaration extraction has started, so cycles stop. */
  readonly declarationStates = new Set<SymbolId>()
  /** Extracted type nodes by allocated id. */
  readonly nodes = new Map<TypeNodeId, TypeNodeModel>()
  /** Export records by package name. */
  readonly exportsByPackage = new Map<string, ExportRecord[]>()
  /** Next ordinal per location key, so one site can hold several nodes. */
  readonly nodeOrdinals = new Map<string, number>()
  /** Lookup-map entries, once the maps have been read. */
  lookups: readonly StaticMapEntry[] | undefined
  /** Context-map entries by key, once the maps have been read. */
  contexts: ReadonlyMap<string, StaticMapEntry> | undefined
  /** First annotation this run would write back in `fix` mode. */
  queuedEdit: SourceEdit | undefined

  /**
   * @param options - face, project, and package registrations to analyze.
   */
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

  /**
   * Follow an alias to the symbol it names.
   * @param symbol - possibly aliased symbol.
   * @returns the aliased target, or the symbol itself when it is not an alias.
   */
  resolveSymbol(symbol: Symbol): Symbol {
    return (symbol.flags & SymbolFlags.Alias) === 0 ? symbol : this.checker.getAliasedSymbol(symbol)
  }

  /**
   * Stable identity for a symbol across this run.
   * @param symbol - symbol to identify; aliases resolve first.
   * @returns `<declaring file>#<name>`, falling back to the name when the symbol has no declaration.
   */
  symbolId(symbol: Symbol): SymbolId {
    const resolved = this.resolveSymbol(symbol)
    const declaration = preferredDeclaration(resolved, this.project.project)
    const file = declaration === undefined ? resolved.name : declaration.getSourceFile().fileName
    return `${slash(file)}#${resolved.name}`
  }

  /**
   * Package that owns a file, preferring this face's own registrations.
   * @param file - path inside a package.
   * @returns the owning registration, or undefined when no package contains the file.
   */
  registrationForFile(file: string): PackageRegistration | undefined {
    const path = realPath(file)
    return this.registrations.find(registration => path === registration.root || path.startsWith(`${registration.root}/`))
      ?? this.allRegistrations.find(registration =>
        registration.face === this.face && (path === registration.root || path.startsWith(`${registration.root}/`)))
  }

  /**
   * Package that owns a file in any registered face.
   * @param file - path inside a package.
   * @returns the owning registration, or undefined when no package contains the file.
   */
  registrationOwningFile(file: string): PackageRegistration | undefined {
    const path = realPath(file)
    return this.registrationForFile(file)
      ?? this.allRegistrations.find(registration => path === registration.root || path.startsWith(`${registration.root}/`))
  }

  /**
   * Repository-relative position of a node.
   * @param node - node in this project.
   * @returns file, 1-based line, and 1-based column.
   */
  location(node: Node): SourceLocation {
    const sourceFile = node.getSourceFile()
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile))
    return {
      file: slash(relative(this.root, sourceFile.fileName)),
      line: position.line + 1,
      column: position.character + 1,
    }
  }

  /**
   * Location rendered as one key.
   * @param node - node in this project.
   * @returns `file:line:column`.
   */
  locationKey(node: Node): string {
    const location = this.location(node)
    return `${location.file}:${String(location.line)}:${String(location.column)}`
  }

  /**
   * Reserve the next type-node id at a site.
   * @param site - node the type was authored at.
   * @returns `file:line:column#ordinal`, counting up per site.
   */
  allocateNodeId(site: Node): TypeNodeId {
    const key = this.locationKey(site)
    const ordinal = this.nodeOrdinals.get(key) ?? 0
    this.nodeOrdinals.set(key, ordinal + 1)
    return `${key}#${String(ordinal)}`
  }

  /**
   * Record one type node in the graph.
   * @param site - node the type was authored at.
   * @param model - node model without its id.
   * @returns the allocated id.
   */
  addNode(site: Node, model: TypeNodeInput): TypeNodeId {
    const id = this.allocateNodeId(site)
    this.nodes.set(id, { id, ...model })
    return id
  }

  /**
   * Abort analysis with a located message.
   * @param node - node the problem was found at.
   * @param message - what is wrong.
   * @returns never; the call always throws `TypertAnalysisError`.
   */
  fail(node: Node, message: string): never {
    const location = this.location(node)
    throw new TypertAnalysisError(
      `typert(${this.face}): ${location.file}:${String(location.line)}:${String(location.column)}: ${message}`,
    )
  }

  /**
   * Print a node through this face's emitter.
   * @param node - node bound in this project, or a factory update of one.
   * @returns printed TypeScript text.
   */
  print(node: Node): string {
    return this.project.printNode(node)
  }

  /**
   * Symbol a type node names. A reference resolves its own name; any other node
   * resolves through its type's alias or declared symbol.
   * @param node - authored type node.
   * @returns the resolved symbol, or undefined when the node names none.
   */
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

  /**
   * Record a reference to a declaration in this face.
   * @param symbol - referenced symbol.
   * @param site - node the reference was authored at.
   * @returns the allocated type-node id.
   */
  referenceNode(symbol: Symbol, site: Node): TypeNodeId {
    return this.addNode(site, {
      kind: 'reference',
      name: symbol.name,
      target: { kind: 'declaration', symbol: this.symbolId(symbol) },
      arguments: [],
    })
  }

  /**
   * The authored type, or the inferred one when the annotation is absent.
   * `check` mode fails instead; `fix` mode queues the first missing annotation
   * as a source edit.
   * @param owner - declaration the type belongs to.
   * @param type - authored type node, if any.
   * @param purpose - which position the type annotates.
   * @returns the type node to extract from.
   */
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

  /**
   * Infer the type node for an unannotated position.
   * @param owner - declaration missing the annotation.
   * @param purpose - which position to infer.
   * @returns the inferred type node.
   */
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

  /**
   * Build an untruncated type node for a checker type.
   * @param type - checker type to render.
   * @param owner - node the type is written at, for name resolution.
   * @param message - failure text when the checker builds no node.
   * @returns the built type node.
   */
  typeNodeOf(type: Type, owner: Node, message: string): TypeNode {
    const node = this.checker.typeToTypeNode(
      type,
      owner,
      NodeBuilderFlags.NoTruncation | NodeBuilderFlags.UseAliasDefinedOutsideCurrentScope,
    )
    if (node === undefined) this.fail(owner, message)
    return node
  }

  /**
   * The name a package's export subpath publishes a symbol under.
   * @param module - owning package and export subpath.
   * @param symbol - symbol the export must resolve to.
   * @param face - face whose registration of the package to read.
   * @param requestedName - exported name to look for.
   * @returns the exported name, or undefined when that subpath does not
   *   publish this symbol.
   */
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

  /**
   * Record that this face references a name owned by the other face.
   * Repeated links collapse: the key is the link's own fields.
   * @param fromPackage - package holding the reference.
   * @param toFace - face owning the referenced name.
   * @param module - owning package and export subpath.
   * @param name - referenced export name.
   */
  recordCrossFaceLink(
    fromPackage: string,
    toFace: TypertFace,
    module: { readonly package: string; readonly subpath: string },
    name: string,
  ): void {
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
