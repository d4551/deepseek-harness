/**
 * TypeScript 7 helpers for Typert generator tests. Isolated parse, printing,
 * and diagnostic programs go through `typescript/unstable/*`.
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from 'jsonc-parser'
import {
  isIdentifier,
  isInterfaceDeclaration,
  isEnumMember,
  isFunctionDeclaration,
  isMethodDeclaration,
  isModuleDeclaration,
  isParameterDeclaration,
  isPropertyAccessExpression,
  isPropertyDeclaration,
  isPropertySignatureDeclaration,
  isTypeAliasDeclaration,
  isTypeParameterDeclaration,
  isVariableDeclaration,
} from 'typescript/unstable/ast/is'
import type { Node, SourceFile, TypeNode } from 'typescript/unstable/ast'
import { SymbolFlags } from 'typescript/unstable/sync'
import { FaceProject } from '../src/ts7-project.ts'
import { isTypeDeclaration, preferredDeclaration } from '../src/ts7-syntax.ts'
import { createSourceFile, parsePath } from '../src/ts7-session.ts'
import { formatDiagnostic } from './type-model-shared.ts'

export {
  isInterfaceDeclaration,
  isPropertySignatureDeclaration,
  isTypeAliasDeclaration,
}

/**
 * Parse TypeScript source text.
 * @param fileName - path used as the source-file name.
 * @param text - file contents.
 * @returns the bound source file.
 */
export function parseSource(fileName: string, text: string): SourceFile {
  return createSourceFile(fileName, text)
}

/**
 * Print a type node as source text.
 * @param node - type node.
 * @returns the node's text.
 */
export function printType(node: TypeNode): string {
  return node.getText()
}

/**
 * Canonicalize a type string by round-tripping through parse.
 * @param text - rendered type.
 * @returns printed type-node text.
 */
export function canonicalType(text: string): string {
  const source = createSourceFile('canonical-type.ts', `type Canonical = ${text}\n`)
  const declaration = source.statements[0]
  if (declaration === undefined || !isTypeAliasDeclaration(declaration)) {
    throw new Error(`cannot parse rendered type ${text}`)
  }
  return printType(declaration.type)
}

/**
 * Open one tsconfig and return its flattened file-diagnostic messages.
 * @param configPath - absolute tsconfig path.
 * @returns diagnostic messages.
 */
function flattenedFileDiagnostics(configPath: string): string[] {
  return new FaceProject(configPath).fileDiagnostics().map(formatDiagnostic)
}

/**
 * Compile the given files with a temporary tsconfig and return diagnostics.
 * @param files - absolute source or declaration paths.
 * @returns flattened diagnostic messages.
 */
export function compileFiles(files: readonly string[]): string[] {
  const first = files[0]
  if (first === undefined) return []
  const configPath = join(dirname(first), 'tsconfig.typert-check.json')
  writeFileSync(configPath, [
    '{',
    '  "compilerOptions": {',
    '    "strict": true,',
    '    "noEmit": true,',
    '    "skipLibCheck": false,',
    '    "target": "ES2024",',
    '    "module": "ESNext",',
    '    "moduleResolution": "bundler"',
    '  },',
    `  "files": ${fileList(files)}`,
    '}',
    '',
  ].join('\n'))
  return flattenedFileDiagnostics(configPath)
}

/**
 * Source-file names loaded by opening a tsconfig.
 * @param configPath - absolute tsconfig path.
 * @returns slash-normalized file names.
 */
export function projectFileNames(configPath: string): string[] {
  return new FaceProject(configPath).sourceFiles()
    .map(source => source.fileName.replaceAll('\\', '/'))
}

function fileList(files: readonly string[]): string {
  return '[' + files.map(file => `"${file.replaceAll('\\', '/').replaceAll('"', '\\"')}"`).join(', ') + ']'
}

export function parseOnDisk(file: string): SourceFile {
  return parsePath(file)
}

/**
 * Open one tsconfig and return flattened file diagnostics.
 * @param configPath - absolute tsconfig path.
 * @returns diagnostic messages.
 */
export function compileTsconfig(configPath: string): string[] {
  return flattenedFileDiagnostics(configPath)
}

/** One file diagnostic from an opened tsconfig. */
export interface FileDiagnostic {
  readonly code: number
  readonly message: string
  readonly fileName?: string
}

/**
 * Open one tsconfig and return file diagnostics with codes.
 * @param configPath - absolute tsconfig path.
 * @returns diagnostics that name a file.
 */
export function compileDiagnostics(configPath: string): FileDiagnostic[] {
  return new FaceProject(configPath).fileDiagnostics().map((diagnostic) => {
    const fileName = diagnostic.fileName
    return {
      code: diagnostic.code,
      message: formatDiagnostic(diagnostic),
      ...(fileName === undefined ? {} : { fileName }),
    }
  })
}

/**
 * Resolve the named declaration of a property-access path through the checker.
 * @param configPath - absolute tsconfig that includes `fileName`.
 * @param fileName - absolute source path.
 * @param navigation - full property-access text such as `ctx.remote.goals.create`.
 * @returns the declaration identifier's file, offset, and generated line/column.
 */
export function definitionAt(
  configPath: string,
  fileName: string,
  navigation: string,
): { fileName: string; start: number; length: number; line: number; character: number } {
  const project = new FaceProject(configPath)
  const source = project.sourceFile(fileName)
  if (source === undefined) throw new Error(`missing ${fileName}`)
  const identifier = findNavigation(source, navigation)
  const symbol = project.checker.getSymbolAtLocation(identifier)
  if (symbol === undefined) throw new Error(`no symbol for ${navigation}`)
  const resolved = (symbol.flags & SymbolFlags.Alias) === 0
    ? symbol
    : project.checker.getAliasedSymbol(symbol)
  const declaration = preferredDeclaration(resolved, project.project)
  if (declaration === undefined) throw new Error(`no declaration for ${navigation}`)
  const named = identifierOf(declaration)
  const file = named.getSourceFile()
  const start = named.getStart(file)
  const { line, character } = file.getLineAndCharacterOfPosition(start)
  return {
    fileName: file.fileName,
    start,
    length: named.getText(file).length,
    line,
    character,
  }
}

function findNavigation(source: SourceFile, navigation: string): Node {
  let found: Node | undefined
  const visit = (node: Node) => {
    if (found !== undefined) return
    if (isPropertyAccessExpression(node) && node.getText() === navigation) {
      found = node.name
      return
    }
    node.forEachChild(visit)
  }
  visit(source)
  if (found === undefined) throw new Error(`navigation ${navigation} not found`)
  return found
}

function identifierOf(node: Node): Node {
  if (isIdentifier(node)) return node
  if (isTypeDeclaration(node)
    || isFunctionDeclaration(node)
    || isMethodDeclaration(node)
    || isPropertyDeclaration(node)
    || isParameterDeclaration(node)
    || isVariableDeclaration(node)
    || isEnumMember(node)
    || isModuleDeclaration(node)
    || isTypeParameterDeclaration(node)
    || isPropertyAccessExpression(node)) {
    return node.name ?? node
  }
  return node
}

const VLQ = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/**
 * Map a generated 1-based line and 0-based column through a VLQ source map.
 * @param mapText - encoded source-map JSON.
 * @param generatedLine - 1-based generated line.
 * @param generatedColumn - 0-based generated column.
 * @returns the last covering original position on that line.
 */
export function originalPositionFor(
  mapText: string,
  generatedLine: number,
  generatedColumn: number,
): { source: string; line: number; column: number; name?: string } | undefined {
  const map = parse(mapText)
  if (map === null || typeof map !== 'object' || Array.isArray(map)) {
    throw new Error('source map is not an object')
  }
  const mappings = Reflect.get(map, 'mappings')
  const sources = Reflect.get(map, 'sources')
  const names = Reflect.get(map, 'names')
  if (typeof mappings !== 'string' || !Array.isArray(sources)) {
    throw new Error('source map missing mappings or sources')
  }
  const rows = mappings.split(';')
  let sourceIndex = 0
  let originalLine = 0
  let originalColumn = 0
  let nameIndex = 0
  let match: { source: string; line: number; column: number; name?: string } | undefined
  for (let lineIndex = 0; lineIndex < rows.length; lineIndex++) {
    const row = rows[lineIndex] ?? ''
    let generatedColumnCursor = 0
    if (row !== '') {
      for (const segment of row.split(',')) {
        const decoded = decodeVlq(segment)
        const columnDelta = decoded[0]
        if (columnDelta === undefined) continue
        generatedColumnCursor += columnDelta
        if (decoded.length >= 4) {
          sourceIndex += requiredNumber(decoded, 1)
          originalLine += requiredNumber(decoded, 2)
          originalColumn += requiredNumber(decoded, 3)
          const mappedName = decoded[4]
          if (mappedName !== undefined) nameIndex += mappedName
        }
        if (lineIndex + 1 === generatedLine && generatedColumnCursor <= generatedColumn) {
          const source = sources[sourceIndex]
          if (typeof source === 'string') {
            const name = Array.isArray(names) ? names[nameIndex] : undefined
            match = {
              source,
              line: originalLine + 1,
              column: originalColumn,
              ...(typeof name === 'string' ? { name } : {}),
            }
          }
        }
      }
    }
  }
  return match
}

function requiredNumber(values: readonly number[], index: number): number {
  const value = values[index]
  if (value === undefined) throw new Error(`VLQ segment missing component ${String(index)}`)
  return value
}

function decodeVlq(segment: string): number[] {
  const values: number[] = []
  let value = 0
  let shift = 0
  for (const char of segment) {
    const index = VLQ.indexOf(char)
    if (index < 0) throw new Error(`invalid source-map VLQ ${char}`)
    value += (index & 31) << shift
    if ((index & 32) !== 0) {
      shift += 5
      continue
    }
    const negative = (value & 1) !== 0
    const magnitude = value >> 1
    values.push(negative ? -magnitude : magnitude)
    value = 0
    shift = 0
  }
  return values
}

/**
 * Convert a 1-based line and 0-based column into a file offset.
 * @param text - file contents.
 * @param line - 1-based line.
 * @param column - 0-based column.
 * @returns the character offset.
 */
export function offsetAt(text: string, line: number, column: number): number {
  let offset = 0
  let current = 1
  while (current < line) {
    const next = text.indexOf('\n', offset)
    if (next < 0) return offset
    offset = next + 1
    current += 1
  }
  return offset + column
}
