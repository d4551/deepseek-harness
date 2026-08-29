/**
 * TypeScript 7 helpers for Typert generator tests. Isolated parse, printing,
 * and diagnostic programs go through `typescript/unstable/*`.
 */

import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  isInterfaceDeclaration,
  isPropertySignatureDeclaration,
  isTypeAliasDeclaration,
} from 'typescript/unstable/ast/is'
import type { SourceFile, TypeNode } from 'typescript/unstable/ast'
import { FaceProject } from '../src/ts7-project.ts'
import { createSourceFile, flattenDiagnosticMessageText, parsePath } from '../src/ts7-session.ts'

export {
  isInterfaceDeclaration,
  isPropertySignatureDeclaration as isPropertySignature,
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
  const project = new FaceProject(configPath)
  return project.fileDiagnostics().map(diagnostic => flattenDiagnosticMessageText(diagnostic, '\n'))
}

/**
 * Source-file names loaded by opening a tsconfig.
 * @param configPath - absolute tsconfig path.
 * @returns slash-normalized file names.
 */
export function projectFileNames(configPath: string): string[] {
  const project = new FaceProject(configPath)
  return project.sourceFiles().map(source => source.fileName.replaceAll('\\', '/'))
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
  const project = new FaceProject(configPath)
  return project.fileDiagnostics().map(diagnostic => flattenDiagnosticMessageText(diagnostic, '\n'))
}
