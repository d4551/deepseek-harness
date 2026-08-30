/**
 * Package export graph, Cordis services/events, and face model assembly.
 */

import type { InterfaceDeclaration, SourceFile } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isExportDeclaration,
  isImportDeclaration,
  isInterfaceDeclaration,
  isMethodSignatureDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isNamespaceExport,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isUnionTypeNode,
} from 'typescript/unstable/ast/is'
import { SyntaxKind } from 'typescript/unstable/ast'
import type { FaceContext, ExportRecord } from './analyzer-context.ts'
import { ensureDeclaration } from './analyzer-decl.ts'
import { documentationOf, memberName, typertMode, typertServiceTag } from './analyzer-docs.ts'
import { TypertAnalysisError } from './analyzer-error.ts'
import { isSourceExportTarget, packageExportTargets, sourcePathForExport } from './analyzer-exports.ts'
import { functionSignature } from './analyzer-members.ts'
import { collectInvocations, validateInvocationIdentity } from './analyzer-invoke.ts'
import { moduleIdentity } from './analyzer-names.ts'
import { convertType } from './analyzer-convert.ts'
import { isRemoteSegment } from './analyzer-names.ts'
import type { PackageRegistration } from './analyzer-types.ts'
import { isWithin, realPath, slash, uniqueBy } from './analyzer-util.ts'
import { getTextOfJSDocComment } from 'typescript/unstable/ast'
import type {
  EventModel,
  FaceModel,
  ObjectModel,
  PackageModel,
  SchemaModel,
  ServiceModel,
} from './model.ts'
import { isTypeDeclaration, preferredDeclaration } from './ts7-syntax.ts'
import { relative } from 'node:path'

/**
 * Analyze every selected package on this face.
 * @param face - extraction context.
 * @returns the face model.
 */
export function analyzeFace(face: FaceContext): FaceModel {
  for (const registration of face.registrations) {
    face.exportsByPackage.set(registration.name, collectExports(face, registration))
  }
  const packages = face.registrations
    .map(registration => analyzePackage(face, registration))
    .filter(hasPackageSurface)
  validateInvocationIdentity(face, packages)
  return {
    face: face.face,
    packages,
    graph: {
      declarations: [...face.declarations.values()].sort((left, right) => left.id.localeCompare(right.id)),
      nodes: [...face.nodes.values()].sort((left, right) => left.id.localeCompare(right.id)),
    },
  }
}

function hasPackageSurface(model: PackageModel): boolean {
  return model.services.length > 0
    || model.events.length > 0
    || model.objects.length > 0
    || model.schemas.length > 0
    || model.invocations.length > 0
}

function analyzePackage(face: FaceContext, registration: PackageRegistration): PackageModel {
  const records = face.exportsByPackage.get(registration.name) ?? []
  const reachable = reachableFiles(face, registration, records.map(record => record.sourceFile))
  const services: ServiceModel[] = []
  const events: EventModel[] = []
  for (const sourceFile of reachable) {
    for (const statement of sourceFile.statements) {
      if (!isModuleDeclaration(statement) || !isStringLiteral(statement.name)
        || statement.name.text !== '@deepseek-ai/cordis'
        || statement.body === undefined || !isModuleBlock(statement.body)) continue
      for (const member of statement.body.statements) {
        if (!isInterfaceDeclaration(member)) continue
        if (member.name.text === 'Context') services.push(...collectServices(face, member, records))
        else if (member.name.text === 'Events') events.push(...collectEvents(face, member))
      }
    }
  }
  const objects: ObjectModel[] = []
  const schemas: SchemaModel[] = []
  collectBusinessTypes(face, records, objects, schemas)
  return {
    name: registration.name,
    root: slash(relative(face.root, registration.root)),
    exports: records.map(record => record.model)
      .sort((left, right) => left.subpath.localeCompare(right.subpath) || left.name.localeCompare(right.name)),
    services: uniqueBy([...collectExplicitServices(face, records), ...services], service => service.key)
      .sort((left, right) => left.key.localeCompare(right.key)),
    events: uniqueBy(events, event => event.name).sort((left, right) => left.name.localeCompare(right.name)),
    objects: objects.sort((left, right) => left.export.name.localeCompare(right.export.name)),
    schemas: schemas.sort((left, right) => left.export.name.localeCompare(right.export.name)),
    invocations: face.face === 'host'
      ? collectInvocations(face, registration, reachable).sort((left, right) => left.id.localeCompare(right.id))
      : [],
  }
}

function collectBusinessTypes(
  face: FaceContext,
  records: readonly ExportRecord[],
  objects: ObjectModel[],
  schemas: SchemaModel[],
) {
  const seen = new Set<string>()
  for (const record of records) {
    const declaration = record.declaration
    if (!isTypeDeclaration(declaration)) continue
    if (face.registrationForFile(declaration.getSourceFile().fileName) === undefined) continue
    const symbol = face.resolveSymbol(record.symbol)
    const symbolId = face.symbolId(symbol)
    if (seen.has(symbolId)) continue
    const mode = typertMode(declaration)
    if (mode !== 'object' && mode !== 'schema') continue
    seen.add(symbolId)
    ensureDeclaration(face, symbol, declaration)
    const documentation = documentationOf(declaration)
    if (mode === 'object') objects.push({ ...documentation, export: record.model, symbol: symbolId, passing: 'reference' })
    else schemas.push({ ...documentation, export: record.model, symbol: symbolId, type: face.referenceNode(symbol, declaration) })
  }
}

function collectExports(face: FaceContext, registration: PackageRegistration): ExportRecord[] {
  const targets = packageExportTargets(registration.manifest)
    .filter(([subpath]) => registration.exportSubpaths === undefined || registration.exportSubpaths.includes(subpath))
  const records: ExportRecord[] = []
  for (const [subpath, target] of targets) {
    if (!isSourceExportTarget(subpath, target)) continue
    const sourcePath = sourcePathForExport(registration.root, target)
    const sourceFile = face.sourceFiles.get(realPath(sourcePath))
    if (sourceFile === undefined) {
      throw new TypertAnalysisError(
        `typert(${face.face}): ${registration.name} export ${subpath} resolves to missing source ${sourcePath}`,
      )
    }
    const moduleSymbol = face.checker.getSymbolAtLocation(sourceFile)
    if (moduleSymbol === undefined) continue
    for (const exported of face.checker.getExportsOfModule(moduleSymbol)) {
      const symbol = face.resolveSymbol(exported)
      const declaration = preferredDeclaration(symbol, face.project.project)
      if (declaration === undefined) continue
      const aliases = exported === symbol || exported.name === symbol.name
        ? [exported.name]
        : [exported.name, symbol.name]
      records.push({
        model: { subpath, name: exported.name, symbol: face.symbolId(symbol), aliases },
        symbol,
        declaration,
        sourceFile,
      })
    }
  }
  const unique = uniqueBy(records, record => `${record.model.subpath}\0${record.model.name}`)
  collectCrossFaceReExports(face, registration, unique)
  return unique
}

function collectCrossFaceReExports(face: FaceContext, registration: PackageRegistration, records: readonly ExportRecord[]) {
  const publicSymbols = new Set(records.map(record => record.symbol))
  const entryFiles = uniqueBy(records, record => record.sourceFile.fileName).map(record => record.sourceFile)
  for (const sourceFile of reachableFiles(face, registration, entryFiles)) {
    for (const statement of sourceFile.statements) {
      if (!isExportDeclaration(statement) || statement.moduleSpecifier === undefined
        || !isStringLiteral(statement.moduleSpecifier)) continue
      const module = moduleIdentity(statement.moduleSpecifier.text)
      if (module === undefined) continue
      const toFace = face.allRegistrations
        .find(candidate => candidate.name === module.package && candidate.face !== face.face)?.face
      if (toFace === undefined) continue
      if (statement.exportClause !== undefined && isNamespaceExport(statement.exportClause)) {
        const namespaceSymbol = face.checker.getSymbolAtLocation(statement.exportClause.name)
        if (namespaceSymbol !== undefined && publicSymbols.has(face.resolveSymbol(namespaceSymbol))) {
          face.fail(statement.exportClause, 'cross-face namespace re-exports are not supported')
        }
        continue
      }
      walkReExports(face, registration, statement, module, toFace, publicSymbols)
    }
  }
}

function walkReExports(
  face: FaceContext,
  registration: PackageRegistration,
  statement: import('typescript/unstable/ast').ExportDeclaration,
  module: { readonly package: string; readonly subpath: string },
  toFace: import('./model.ts').TypertFace,
  publicSymbols: Set<ExportRecord['symbol']>,
) {
  const exports = statement.exportClause === undefined
    ? (statement.moduleSpecifier === undefined
      ? []
      : moduleExports(face, statement.moduleSpecifier).map(symbol => ({
        symbol: face.resolveSymbol(symbol),
        requestedName: symbol.name,
        site: statement,
      })))
    : isNamespaceExport(statement.exportClause)
      ? []
      : statement.exportClause.elements.map((element) => {
        const symbol = face.checker.getSymbolAtLocation(element.name)
        return {
          symbol: symbol === undefined ? undefined : face.resolveSymbol(symbol),
          requestedName: element.propertyName?.text ?? element.name.text,
          site: element,
        }
      })
  for (const exported of exports) {
    if (exported.symbol === undefined || !publicSymbols.has(exported.symbol)) continue
    const name = face.packageExportName(module, exported.symbol, toFace, exported.requestedName)
    if (name === undefined) {
      face.fail(exported.site, `cross-face re-export ${exported.requestedName} is not exported by ${module.package} at ${module.subpath}`)
    }
    face.recordCrossFaceLink(registration.name, toFace, module, name)
  }
}

function moduleExports(face: FaceContext, moduleSpecifier: import('typescript/unstable/ast').Expression) {
  const moduleSymbol = face.checker.getSymbolAtLocation(moduleSpecifier)
  return moduleSymbol === undefined ? [] : [...face.checker.getExportsOfModule(moduleSymbol)]
}

function reachableFiles(face: FaceContext, registration: PackageRegistration, entryFiles: readonly SourceFile[]): SourceFile[] {
  const reachable = new Map<string, SourceFile>()
  const queue = [...entryFiles]
  while (queue.length > 0) {
    const sourceFile = queue.shift()
    if (sourceFile === undefined) continue
    const fileName = realPath(sourceFile.fileName)
    if (reachable.has(fileName) || !isWithin(fileName, registration.root)) continue
    reachable.set(fileName, sourceFile)
    for (const statement of sourceFile.statements) {
      if ((!isImportDeclaration(statement) && !isExportDeclaration(statement))
        || statement.moduleSpecifier === undefined
        || !isStringLiteral(statement.moduleSpecifier)) continue
      const symbol = face.checker.getSymbolAtLocation(statement.moduleSpecifier)
      if (symbol === undefined) continue
      const declaration = preferredDeclaration(face.resolveSymbol(symbol), face.project.project)
      if (declaration === undefined) continue
      const resolved = face.sourceFiles.get(realPath(declaration.getSourceFile().fileName))
      if (resolved !== undefined) queue.push(resolved)
    }
  }
  return [...reachable.values()].sort((left, right) => left.fileName.localeCompare(right.fileName))
}

function collectServices(face: FaceContext, context: InterfaceDeclaration, records: readonly ExportRecord[]): ServiceModel[] {
  const bySymbol = new Map<string, ExportRecord[]>()
  for (const record of records) {
    const id = face.symbolId(record.symbol)
    const matches = bySymbol.get(id) ?? []
    matches.push(record)
    bySymbol.set(id, matches)
  }
  const result: ServiceModel[] = []
  for (const member of context.members) {
    if (!isPropertySignatureDeclaration(member)) continue
    if (member.postfixToken !== undefined
      || (isUnionTypeNode(member.type) && member.type.types.some(node => node.kind === SyntaxKind.UndefinedKeyword))) continue
    const authoredSymbol = face.symbolAtType(member.type)
    if (authoredSymbol === undefined) continue
    const authoredSymbolId = face.symbolId(authoredSymbol)
    const exported = bySymbol.get(authoredSymbolId)?.find(record => record.model.name === authoredSymbol.name)
      ?? bySymbol.get(authoredSymbolId)?.find(record => record.model.name !== 'default')
      ?? bySymbol.get(authoredSymbolId)?.[0]
    if (exported === undefined) continue
    const resolved = resolveServiceDeclaration(face, member, authoredSymbol)
    if (resolved === undefined) continue
    result.push({
      ...documentationOf(resolved.declaration),
      key: memberName(member.name),
      symbol: resolved.symbolId,
      export: exported.model,
      members: resolved.declarationModel.members.filter(memberModel => memberModel.visibility === 'public' && !memberModel.static).map(memberModel => memberModel.id),
      location: face.location(member),
    })
  }
  return result
}

function resolveServiceDeclaration(face: FaceContext, member: import('typescript/unstable/ast').TypeElement, authoredSymbol: ExportRecord['symbol']) {
  let symbol = authoredSymbol
  let declaration = preferredDeclaration(symbol, face.project.project)
  const aliases = new Set<ExportRecord['symbol']>()
  while (declaration !== undefined && isTypeAliasDeclaration(declaration)) {
    if (aliases.has(symbol)) break
    aliases.add(symbol)
    const target = face.symbolAtType(declaration.type)
    if (target === undefined) break
    symbol = target
    declaration = preferredDeclaration(symbol, face.project.project)
  }
  if (declaration === undefined || (!isTypeDeclaration(declaration))) return undefined
  if (!('name' in declaration)) return undefined
  const memberOwner = face.registrationForFile(member.getSourceFile().fileName)
  const declarationOwner = face.registrationForFile(declaration.getSourceFile().fileName)
  if (memberOwner?.name !== declarationOwner?.name) return undefined
  if (!isTypeDeclaration(declaration)) return undefined
  return {
    symbolId: face.symbolId(symbol),
    declaration,
    declarationModel: ensureDeclaration(face, symbol, declaration),
  }
}

function collectExplicitServices(face: FaceContext, records: readonly ExportRecord[]): ServiceModel[] {
  const result: ServiceModel[] = []
  const seen = new Set<string>()
  for (const record of records) {
    const tag = typertServiceTag(record.declaration)
    if (tag === undefined) continue
    const words = (getTextOfJSDocComment(tag.comment) ?? '').trim().split(/\s+/)
    if (words.length !== 2 || words[1] === undefined || !isRemoteSegment(words[1])) {
      face.fail(tag, '@typert service requires exactly one nonempty Cordis service key without "/"')
    }
    if (!isClassDeclaration(record.declaration)) {
      face.fail(record.declaration, '@typert service requires an exported class')
    }
    const symbol = face.resolveSymbol(record.symbol)
    const symbolId = face.symbolId(symbol)
    if (seen.has(symbolId)) continue
    seen.add(symbolId)
    const model = ensureDeclaration(face, symbol, record.declaration)
    result.push({
      ...documentationOf(record.declaration),
      key: words[1],
      symbol: symbolId,
      export: record.model,
      members: model.members.filter(member => member.visibility === 'public' && !member.static).map(member => member.id),
      location: face.location(record.declaration),
    })
  }
  return result
}

function collectEvents(face: FaceContext, events: InterfaceDeclaration): EventModel[] {
  const result: EventModel[] = []
  for (const member of events.members) {
    const documentation = documentationOf(member)
    const mode = documentation.tags.find(tag => tag.name === 'mode')?.comment?.trim()
    if (isMethodSignatureDeclaration(member)) {
      result.push({
        ...documentation,
        name: memberName(member.name),
        signature: face.addNode(member, { kind: 'function', signature: functionSignature(face, member, member.type) }),
        text: member.getText(),
        ...mode === undefined ? {} : { mode },
        location: face.location(member),
      })
    } else if (isPropertySignatureDeclaration(member)) {
      result.push({
        ...documentation,
        name: memberName(member.name),
        signature: convertType(face, member.type),
        text: member.getText(),
        ...mode === undefined ? {} : { mode },
        location: face.location(member),
      })
    }
  }
  return result
}
