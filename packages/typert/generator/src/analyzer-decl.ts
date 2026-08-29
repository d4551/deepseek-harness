/**
 * Named type-declaration extraction.
 */

import type { ClassDeclaration, InterfaceDeclaration } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isEnumDeclaration,
  isInterfaceDeclaration,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import type { Symbol } from 'typescript/unstable/sync'
import type { FaceContext } from './analyzer-context.ts'
import { convertType, targetForReference } from './analyzer-convert.ts'
import { declarationText, documentationOf, memberName } from './analyzer-docs.ts'
import { declarationName } from './analyzer-literals.ts'
import { collectMembers, mergeTypeParameters, typeParametersOf } from './analyzer-members.ts'
import type { TypeDeclarationModel, TypeNodeId } from './model.ts'
import { hasModifier, isTypeDeclaration, resolveDeclarations } from './ts7-syntax.ts'
import type { TypeDeclaration } from './ts7-syntax.ts'

/**
 * Materialize a named type declaration into the graph, merging interface parts.
 * @param face - extraction context.
 * @param symbol - declaration symbol.
 * @param selected - the declaration used for location and documentation.
 * @returns the stored declaration model.
 */
export function ensureDeclaration(face: FaceContext, symbol: Symbol, selected: TypeDeclaration): TypeDeclarationModel {
  const resolved = face.resolveSymbol(symbol)
  const id = face.symbolId(resolved)
  const existing = face.declarations.get(id)
  if (existing !== undefined) return existing
  const declarationParts = resolveDeclarations(resolved, face.project.project).filter(isTypeDeclaration)
  if (declarationParts.length > 1 && !declarationParts.every(isInterfaceDeclaration)) {
    face.fail(selected, `merged ${SyntaxKind[selected.kind]} declaration ${resolved.name} is not supported`)
  }
  if (selected.name === undefined) {
    face.fail(selected, `anonymous ${SyntaxKind[selected.kind]} cannot be represented as a named type declaration`)
  }
  const owner = face.registrationForFile(selected.getSourceFile().fileName)
  if (owner === undefined) face.fail(selected, `declaration ${resolved.name} is outside a registered package`)
  face.declarationStates.add(id)
  if (declarationParts.length > 1) {
    const model = mergedInterface(face, id, selected, owner.name, resolved.name, declarationParts)
    face.declarations.set(id, model)
    face.declarationStates.delete(id)
    return model
  }
  const model = singleDeclaration(face, id, selected, owner.name)
  face.declarations.set(id, model)
  face.declarationStates.delete(id)
  return model
}

function singleDeclaration(
  face: FaceContext,
  id: string,
  selected: TypeDeclaration,
  packageName: string,
): TypeDeclarationModel {
  const parameters = isEnumDeclaration(selected) ? [] : typeParametersOf(face, selected.typeParameters)
  const heritage = isTypeAliasDeclaration(selected) || isEnumDeclaration(selected)
    ? { extends: [] as TypeNodeId[], implements: [] as TypeNodeId[] }
    : heritageOf(face, selected)
  const kind = isClassDeclaration(selected)
    ? 'class'
    : isInterfaceDeclaration(selected)
      ? 'interface'
      : isTypeAliasDeclaration(selected)
        ? 'alias'
        : 'enum'
  return {
    ...documentationOf(selected),
    id,
    package: packageName,
    name: declarationName(selected),
    kind,
    abstract: hasModifier(selected, SyntaxKind.AbstractKeyword),
    exported: hasModifier(selected, SyntaxKind.ExportKeyword),
    location: face.location(selected),
    text: declarationText(selected, node => face.print(node)),
    typeParameters: parameters,
    extends: heritage.extends,
    implements: heritage.implements,
    members: isTypeAliasDeclaration(selected) || isEnumDeclaration(selected)
      ? []
      : collectMembers(face, selected.members, id),
    ...isTypeAliasDeclaration(selected) ? { type: convertType(face, selected.type) } : {},
    ...isEnumDeclaration(selected) ? { enumMembers: enumMembersOf(face, selected) } : {},
  }
}

function mergedInterface(
  face: FaceContext,
  id: string,
  selected: TypeDeclaration,
  packageName: string,
  resolvedName: string,
  declarationParts: TypeDeclaration[],
): TypeDeclarationModel {
  const analyzedParts = declarationParts.map((declarationPart) => {
    if (!isInterfaceDeclaration(declarationPart)) face.fail(declarationPart, `merged ${resolvedName} is not an interface`)
    const partOwner = face.registrationForFile(declarationPart.getSourceFile().fileName)
    if (partOwner === undefined) {
      face.fail(declarationPart, `merged interface ${resolvedName} contains a declaration outside this face`)
    }
    const parameters = typeParametersOf(face, declarationPart.typeParameters)
    const heritage = heritageOf(face, declarationPart)
    const members = collectMembers(face, declarationPart.members, id)
    return {
      typeParameters: parameters,
      heritage,
      members,
      model: {
        ...documentationOf(declarationPart),
        package: partOwner.name,
        location: face.location(declarationPart),
        typeParameters: parameters,
        extends: heritage.extends,
        members: members.map(member => member.id),
      },
    }
  })
  return {
    ...documentationOf(selected),
    id,
    package: packageName,
    name: declarationName(selected),
    kind: 'interface',
    abstract: false,
    exported: hasModifier(selected, SyntaxKind.ExportKeyword),
    location: face.location(selected),
    text: declarationText(selected, node => face.print(node)),
    typeParameters: mergeTypeParameters(face, analyzedParts.map(part => part.typeParameters), selected, resolvedName),
    extends: analyzedParts.flatMap(part => part.heritage.extends),
    implements: [],
    members: analyzedParts.flatMap(part => part.members),
    parts: analyzedParts.map(part => part.model),
  }
}

function enumMembersOf(face: FaceContext, declaration: import('typescript/unstable/ast').EnumDeclaration) {
  return declaration.members.map(member => ({
    ...documentationOf(member),
    name: memberName(member.name),
    ...member.initializer === undefined ? {} : { initializer: member.initializer.getText() },
    location: face.location(member),
  }))
}

function heritageOf(
  face: FaceContext,
  declaration: ClassDeclaration | InterfaceDeclaration,
): { extends: TypeNodeId[]; implements: TypeNodeId[] } {
  const result = { extends: [] as TypeNodeId[], implements: [] as TypeNodeId[] }
  for (const clause of declaration.heritageClauses ?? []) {
    const target = clause.token === SyntaxKind.ExtendsKeyword ? result.extends : result.implements
    for (const type of clause.types) {
      const symbol = face.checker.getSymbolAtLocation(type.expression)
      if (symbol === undefined) face.fail(type, `heritage ${type.expression.getText()} has no symbol`)
      target.push(face.addNode(type, {
        kind: 'reference',
        name: type.expression.getText(),
        target: targetForReference(face, face.resolveSymbol(symbol), type),
        arguments: type.typeArguments?.map(argument => convertType(face, argument)) ?? [],
      }))
    }
  }
  return result
}
