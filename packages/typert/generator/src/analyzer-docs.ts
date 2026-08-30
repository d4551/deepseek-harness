/**
 * JSDoc extraction and class-shape printing for Typert declarations.
 */

import type {
  BindingName,
  ClassDeclaration,
  ClassElement,
  JSDoc,
  JSDocTag,
  Node,
  PropertyName,
} from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import { getJSDocTags } from 'typescript/unstable/ast'
import { getLeadingCommentRanges } from 'typescript/unstable/ast/scanner'
import {
  updateClassDeclaration,
  updateConstructorDeclaration,
  updateGetAccessorDeclaration,
  updateMethodDeclaration,
  updatePropertyDeclaration,
  updateSetAccessorDeclaration,
} from 'typescript/unstable/ast/factory'
import {
  isClassDeclaration,
  isComputedPropertyName,
  isConstructorDeclaration,
  isGetAccessorDeclaration,
  isIdentifier,
  isJSDoc,
  isMethodDeclaration,
  isNoSubstitutionTemplateLiteral,
  isNumericLiteral,
  isPrivateIdentifier,
  isPropertyDeclaration,
  isSetAccessorDeclaration,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import type { DocumentationModel, JsDocTagModel } from './model.ts'
import { hasModifier } from './ts7-syntax.ts'
import type { TypeDeclaration } from './ts7-syntax.ts'

const EMPTY_DOCUMENTATION: DocumentationModel = { tags: [] }

export function emptyDocumentation(): DocumentationModel {
  return EMPTY_DOCUMENTATION
}

function normalizedDocText(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const normalized = value.replace(/\s+/g, ' ').trim()
  return normalized.length === 0 ? undefined : normalized
}

function firstSentence(value: string): string {
  return (/^(.*?[.!?])(?:\s|$)/.exec(value)?.[1] ?? value).trim()
}

function rawJsDoc(node: Node): string {
  const sourceFile = node.getSourceFile()
  const source = sourceFile.getFullText()
  const ranges = getLeadingCommentRanges(source, node.getFullStart()) ?? []
  const range = ranges.filter(candidate => source.slice(candidate.pos, candidate.pos + 3) === '/**').at(-1)
  if (range === undefined) return ''
  const raw = source.slice(range.pos, range.end)
  const { line } = sourceFile.getLineAndCharacterOfPosition(range.pos)
  const lineStart = sourceFile.getPositionOfLineAndCharacter(line, 0)
  const indent = source.slice(lineStart, range.pos)
  return raw.split('\n')
    .map((text, index) => index > 0 && text.startsWith(indent) ? text.slice(indent.length) : text)
    .join('\n')
}

/**
 * Read one JSDoc comment as plain text. TS7's `getTextOfJSDocComment` formats
 * `{@link}` parts through the node's remote source-file handle, which raises
 * a circular-structure failure on session-backed programs; text parts and raw
 * node text carry the same content without that traversal.
 * @param comment - JSDoc block or tag comment value.
 * @returns the concatenated comment text, or undefined when absent.
 */
function jsDocCommentText(comment: JSDoc['comment'] | JSDocTag['comment']): string | undefined {
  if (comment === undefined) return undefined
  if (typeof comment === 'string') return comment
  return comment
    .map(part => part.kind === SyntaxKind.JSDocText ? part.text : part.getText(part.getSourceFile()))
    .join('')
}

export function documentationOf(node: Node): DocumentationModel {
  const blocks = (node.jsDoc ?? []).filter(isJSDoc)
  const block = blocks.at(-1)
  if (block === undefined) return EMPTY_DOCUMENTATION
  const description = normalizedDocText(jsDocCommentText(block.comment))
  const tags: JsDocTagModel[] = getJSDocTags(node).map((tag) => {
    const argument = tagArgument(tag)
    const comment = normalizedDocText(jsDocCommentText(tag.comment))
    return {
      name: tag.tagName.text,
      ...argument === undefined ? {} : { argument },
      ...comment === undefined ? {} : { comment },
      text: tag.getText(tag.getSourceFile()).trim(),
    }
  })
  return {
    ...description === undefined ? {} : {
      description,
      summary: firstSentence(description),
    },
    tags,
    jsDoc: rawJsDoc(node),
  }
}

function tagArgument(tag: JSDocTag): string | undefined {
  if (!Object.hasOwn(tag, 'name')) return undefined
  const name = Reflect.get(tag, 'name')
  if (name === null || name === undefined || typeof name !== 'object') return undefined
  if (!('getText' in name) || typeof name.getText !== 'function') return undefined
  return name.getText()
}

export function typertMode(node: Node): 'object' | 'schema' | undefined {
  for (const tag of getJSDocTags(node)) {
    if (tag.tagName.text !== 'typert') continue
    const mode = (jsDocCommentText(tag.comment) ?? '').trim().split(/\s+/, 1)[0]
    if (mode === 'object') return 'object'
    if (mode === '' || mode === 'schema' || mode === 'type') return 'schema'
  }
  return undefined
}

export function typertServiceTag(node: Node): JSDocTag | undefined {
  return getJSDocTags(node).find(tag => tag.tagName.text === 'typert'
    && (jsDocCommentText(tag.comment) ?? '').trim().split(/\s+/, 1)[0] === 'service')
}

/**
 * Display text for a member or parameter name. Property names keep their
 * literal or computed form; destructured parameter patterns print verbatim.
 * @param name - member property name or parameter binding name.
 * @returns the rendered name.
 */
export function memberName(name: PropertyName | BindingName): string {
  if (isIdentifier(name) || isPrivateIdentifier(name) || isStringLiteral(name)
    || isNumericLiteral(name) || isNoSubstitutionTemplateLiteral(name)) return name.text
  if (isComputedPropertyName(name)) return `[${name.expression.getText()}]`
  return name.getText()
}

function classShape(node: ClassDeclaration): ClassDeclaration {
  const nonPublic = (member: ClassElement): boolean =>
    hasModifier(member, SyntaxKind.PrivateKeyword) || hasModifier(member, SyntaxKind.ProtectedKeyword)
  const members = node.members.flatMap((member): ClassElement[] => {
    if (nonPublic(member) || (isPropertyDeclaration(member) && isPrivateIdentifier(member.name))) return []
    if (isMethodDeclaration(member)) {
      return [updateMethodDeclaration(
        member,
        member.modifiers,
        member.asteriskToken,
        member.name,
        member.postfixToken,
        member.typeParameters,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (isConstructorDeclaration(member)) {
      return [updateConstructorDeclaration(
        member,
        member.modifiers,
        member.typeParameters,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (isGetAccessorDeclaration(member)) {
      return [updateGetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.typeParameters,
        member.parameters,
        member.type,
        undefined,
      )]
    }
    if (isSetAccessorDeclaration(member)) {
      return [updateSetAccessorDeclaration(
        member,
        member.modifiers,
        member.name,
        member.typeParameters,
        member.parameters,
        undefined,
      )]
    }
    if (isPropertyDeclaration(member)) {
      return [updatePropertyDeclaration(
        member,
        member.modifiers,
        member.name,
        member.postfixToken,
        member.type,
        undefined,
      )]
    }
    return [member]
  })
  return updateClassDeclaration(
    node,
    node.modifiers,
    node.name,
    node.typeParameters,
    node.heritageClauses,
    members,
  )
}

/**
 * Render a type declaration as TypeScript text. Classes drop private members
 * and method bodies; factory-updated nodes carry no source text, so the caller
 * must supply a TS7 project printer.
 * @param declaration - class, interface, alias, or enum.
 * @param print - TS7 project printer.
 * @returns declaration text without CR.
 */
export function declarationText(
  declaration: TypeDeclaration,
  print: (node: Node) => string,
): string {
  const projected = isClassDeclaration(declaration) ? classShape(declaration) : declaration
  return print(projected).replace(/\r/g, '')
}
