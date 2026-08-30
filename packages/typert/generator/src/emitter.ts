/**
 * Model-driven Typert artifact emitter. It consumes only FaceModel and
 * TypeGraph data; TypeScript compiler nodes are not part of this boundary.
 * Zod schema emission lives in `./schema-emitter.ts` and Remote client
 * emission in `./remote-emitter.ts`.
 * @module @deepseek-ai/dsh-typert-generator/emitter
 */

import type {
  DocumentationModel,
  FaceModel,
  MemberModel,
  PackageModel,
  SymbolId,
  TypeDeclarationModel,
} from './model.ts'
import { TypeGraphRenderer } from './renderer.ts'
import { SchemaEmitter, type SchemaArtifact, indent, quote } from './schema-emitter.ts'
import { RemoteModelEmitter, invocationBoundaryRoots, pushInvocationDescriptorList, pushSchemaDefinitions } from './remote-emitter.ts'

/** Failure to project a modeled construct into an emitted artifact. */
export class TypertEmitError extends Error {
  override name = 'TypertEmitError'
}

/** JavaScript and declaration artifacts for one package on one face. */
export interface ModelEmitResult {
  readonly package: string
  readonly face: FaceModel['face']
  readonly exports: readonly string[]
  readonly js: string
  readonly dts: string
  readonly remote?: RemoteModelEmitResult
}

/** Host-for-Client Remote contribution generated from the Host Program. */
export interface RemoteModelEmitResult {
  readonly js: string
  readonly dts: string
  readonly dtsMap: string
}

interface RuntimeMemberModel {
  readonly kind: MemberModel['kind']
  readonly name: string
  readonly signature: string
  readonly summary?: string
  readonly jsDoc?: string
}

interface RuntimeTypeModel {
  readonly name: string
  readonly declaration: string
}

interface RuntimeServiceModel extends DocumentationModel {
  readonly key: string
  readonly exportName: string
  readonly members: readonly RuntimeMemberModel[]
  readonly types: readonly RuntimeTypeModel[]
}

interface RuntimeEventModel extends DocumentationModel {
  readonly name: string
  readonly mode?: string
  readonly signature: string
}

interface RuntimeObjectModel extends DocumentationModel {
  readonly name: string
  readonly exportName: string
  readonly members: readonly RuntimeMemberModel[]
  readonly types: readonly RuntimeTypeModel[]
}

interface RuntimePackageModel {
  readonly services: readonly RuntimeServiceModel[]
  readonly events: readonly RuntimeEventModel[]
  readonly objects: readonly RuntimeObjectModel[]
}

/** Emit generated runtime and type artifacts from one independently analyzed face. */
export class FaceModelEmitter {
  private readonly renderer: TypeGraphRenderer

  /**
   * Create an emitter for one face graph.
   * @param face - independently analyzed face.
   */
  constructor(private readonly face: FaceModel) {
    this.renderer = new TypeGraphRenderer(face.graph)
  }

  /**
   * Emit one modeled package.
   * @param packageName - exact package name in the face model.
   * @returns executable JavaScript and its precise declaration file.
   */
  emit(packageName: string): ModelEmitResult {
    const packageModel = this.face.packages.find(candidate => candidate.name === packageName)
    if (packageModel === undefined) {
      throw new TypertEmitError(`typert emitter(${this.face.face}): package ${packageName} is not modeled on this face`)
    }
    const schemas = new SchemaEmitter(
      this.renderer,
      packageModel.schemas,
      invocationBoundaryRoots(packageModel.invocations),
    )
    const schemaArtifact = schemas.emit()
    const runtimeModel = this.runtimeModel(packageModel)
    const js = this.renderJs(packageModel, schemaArtifact, runtimeModel)
    const dts = this.renderDts(packageModel, schemaArtifact)
    return {
      package: packageName,
      face: this.face.face,
      exports: packageModel.schemas.map(schema => schema.export.name),
      js,
      dts,
      ...(this.face.face === 'host' && packageModel.invocations.length > 0
        ? { remote: new RemoteModelEmitter(this.renderer).emit(packageModel) }
        : {}),
    }
  }

  private runtimeModel(packageModel: PackageModel): RuntimePackageModel {
    const services = packageModel.services.map((service): RuntimeServiceModel => {
      const members = service.members.map(id => this.runtimeMember(this.renderer.member(id)))
      return {
        ...documentationLiteral(service),
        key: service.key,
        exportName: service.export.name,
        members,
        types: this.runtimeTypes(this.renderer.declarationClosureForMembers(service.members), service.symbol),
      }
    })
    const events = packageModel.events.map((event): RuntimeEventModel => {
      const node = this.renderer.node(event.signature)
      if (node.kind !== 'function') {
        throw new TypertEmitError(`typert emitter(${this.face.face}): event ${event.name} is not a function type`)
      }
      return {
        ...documentationLiteral(event),
        name: event.name,
        ...(event.mode === undefined ? {} : { mode: event.mode }),
        signature: `${quote(event.name)}${this.renderer.renderSignature(node.signature)}`,
      }
    })
    const objects = packageModel.objects.map((object): RuntimeObjectModel => {
      const declaration = this.renderer.declaration(object.symbol)
      return {
        ...documentationLiteral(object),
        name: declaration.name,
        exportName: object.export.name,
        members: declaration.members.map(member => this.runtimeMember(member)),
        types: this.runtimeTypes(this.renderer.declarationClosureForMembers(declaration.members.map(member => member.id)), declaration.id),
      }
    })
    return { services, events, objects }
  }

  private runtimeMember(member: MemberModel): RuntimeMemberModel {
    return {
      kind: member.kind,
      name: member.name,
      signature: this.renderer.renderMember(member, true),
      ...(member.summary === undefined ? {} : { summary: member.summary }),
      ...(member.jsDoc === undefined ? {} : { jsDoc: member.jsDoc }),
    }
  }

  private runtimeTypes(declarations: readonly TypeDeclarationModel[], root: SymbolId): RuntimeTypeModel[] {
    return declarations
      .filter(declaration => declaration.id !== root)
      .map(declaration => ({
        name: declaration.name,
        declaration: this.renderer.renderDeclaration(declaration.id),
      }))
      .sort((left, right) => left.name.localeCompare(right.name))
  }

  private renderJs(
    packageModel: PackageModel,
    schemas: SchemaArtifact,
    runtimeModel: RuntimePackageModel,
  ): string {
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */',
    ]
    pushSchemaDefinitions(lines, schemas)
    for (const schema of schemas.exports) lines.push(`export const ${schema.exportName} = ${schema.internalName}`)
    if (schemas.exports.length > 0) lines.push('')
    const model = JSON.stringify(runtimeModel, null, 2)
    lines.push('export const TYPERT = {')
    lines.push(`  package: ${quote(packageModel.name)},`)
    lines.push(`  face: ${quote(this.face.face)},`)
    lines.push('  schemas: [')
    for (const schema of schemas.exports) {
      lines.push(`    { name: ${quote(schema.exportName)}, schema: ${schema.exportName} },`)
    }
    lines.push('  ],')
    pushInvocationDescriptorList(lines, packageModel.invocations, schemas, 'invocations')
    lines.push(`  model: ${indent(model, 2).trimStart()},`)
    lines.push('}')
    return `${lines.join('\n')}\n`
  }

  private renderDts(packageModel: PackageModel, schemas: SchemaArtifact): string {
    const imports = new Map<string, string[]>()
    for (const schema of schemas.exports) {
      const specifier = packageExportSpecifier(packageModel.name, schema.model.export.subpath)
      const names = imports.get(specifier) ?? []
      names.push(`${schema.model.export.name} as ${schema.exportName}$source`)
      imports.set(specifier, names)
    }
    const lines = [
      '/* Generated by @deepseek-ai/dsh-typert-generator from FaceModel — do not edit. */',
    ]
    if (schemas.exports.length > 0) lines.splice(1, 0, 'import type { z } from \'zod\'')
    for (const [specifier, names] of [...imports].sort(([left], [right]) => left.localeCompare(right))) {
      lines.push(`import type { ${names.sort().join(', ')} } from ${quote(specifier)}`)
    }
    lines.push('')
    for (const schema of schemas.exports) {
      lines.push(`export declare const ${schema.exportName}: z.ZodType<${schema.exportName}$source>`)
    }
    if (schemas.exports.length > 0) lines.push('')
    // The Loader validates and narrows this generated module boundary before
    // registration. Keeping the public declaration unknown prevents every
    // contributing business package from depending on the runtime registry.
    lines.push('export declare const TYPERT: unknown')
    return `${lines.join('\n')}\n`
  }
}

function documentationLiteral(documentation: DocumentationModel): DocumentationModel {
  return {
    ...(documentation.description === undefined ? {} : { description: documentation.description }),
    ...(documentation.summary === undefined ? {} : { summary: documentation.summary }),
    tags: documentation.tags,
    ...(documentation.jsDoc === undefined ? {} : { jsDoc: documentation.jsDoc }),
  }
}

function packageExportSpecifier(packageName: string, subpath: string): string {
  return subpath === '.' ? packageName : `${packageName}${subpath.slice(1)}`
}
