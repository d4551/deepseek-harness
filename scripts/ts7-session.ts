/**
 * TypeScript 7 compiler session for repository gates that need a SourceFile
 * or a parsed tsconfig. Isolated syntax walks import `is*` from
 * `typescript/unstable/ast/is` and `SyntaxKind` from `typescript/unstable/ast`.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { flattenDiagnosticMessage } from '@deepseek-ai/dsh-diagnostic-text'
import { API } from 'typescript/unstable/sync'
import type { Node, SourceFile } from 'typescript/unstable/ast'

let api: API | undefined
let textRoot: string | undefined
let textSerial = 0

function compiler(): API {
  api ??= new API()
  return api
}

/**
 * Shut down the Go compiler session and kill its child process. The channel
 * unrefs the child and kills it at process exit, so a short-lived gate need
 * not call this; a long-lived process that opened a session frees it here.
 */
export function closeCompiler(): void {
  api?.close()
  api = undefined
  textRoot = undefined
  textSerial = 0
}

/**
 * Parse one on-disk TypeScript file through a TypeScript 7 snapshot.
 * @param file - path that already exists.
 * @returns the bound source file.
 */
export function parsePath(file: string): SourceFile {
  const parsed = parsePaths([file])
  const sourceFile = parsed.get(file)
  if (sourceFile === undefined) throw new Error(`ts7: missing source file ${file}`)
  return sourceFile
}

/**
 * Print one node through the emitter of the project that owns `file`.
 * The emitter re-prints from the AST, so an authored type literal comes back
 * normalized: members separated by `;`, without their inner comments.
 * @param file - on-disk path anchoring the owning project.
 * @param node - node from that project's program.
 * @returns printed TypeScript text.
 */
export function printInFile(file: string, node: Node): string {
  const snapshot = compiler().updateSnapshot({ openFiles: [file] })
  const project = snapshot.getDefaultProjectForFile(file)
  if (project === undefined) throw new Error(`ts7: no project for ${file}`)
  return project.emitter.printNode(node)
}

/**
 * Parse many on-disk TypeScript files in one snapshot update.
 * @param files - paths that already exist.
 * @returns path → bound source file.
 */
export function parsePaths(files: readonly string[]): Map<string, SourceFile> {
  const result = new Map<string, SourceFile>()
  if (files.length === 0) return result
  const snapshot = compiler().updateSnapshot({ openFiles: [...files] })
  for (const file of files) {
    const project = snapshot.getDefaultProjectForFile(file)
    if (project === undefined) throw new Error(`ts7: no project for ${file}`)
    const sourceFile = project.program.getSourceFile(file)
    if (sourceFile === undefined) throw new Error(`ts7: missing source file ${file}`)
    result.set(file, sourceFile)
  }
  return result
}

/**
 * Parse source text. Matching on-disk contents reuse the real path; other
 * text is written to a process-temp file the snapshot can open. Relative
 * names resolve against the process working directory, because snapshot
 * programs key source files by absolute path.
 * @param fileName - path used as the source-file name.
 * @param text - file contents.
 * @returns the bound source file.
 */
export function createSourceFile(fileName: string, text: string): SourceFile {
  const file = resolve(fileName)
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return parsePath(file)
  textRoot ??= mkdtempSync(join(tmpdir(), 'dsh-ts7-'))
  textSerial += 1
  const suffix = basename(fileName) || 'input.ts'
  const path = join(textRoot, `${String(textSerial)}-${suffix}`)
  writeFileSync(path, text)
  return parsePath(path)
}

/** One value a JSON/JSONC document can hold: scalars, arrays, or objects. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined }

export interface JsoncParseResult {
  readonly config: JsonValue | undefined
  readonly error?: { readonly messageText: string }
}

/**
 * Parse JSONC the way Strada `parseConfigFileTextToJson` did.
 * @param text - JSONC document.
 * @returns `{ config }` or `{ error }` with a flattenable message.
 */
export function parseConfigFileTextToJson(text: string): JsoncParseResult {
  const errors: ParseError[] = []
  const config = parseJsonc(text, errors, { allowTrailingComma: true }) as JsoncParseResult['config']
  if (errors.length > 0) {
    const first = errors[0]
    if (first === undefined) return { config: undefined, error: { messageText: 'invalid JSONC' } }
    return {
      config: undefined,
      error: { messageText: `JSONC error ${String(first.error)} at offset ${String(first.offset)}` },
    }
  }
  return { config }
}

/**
 * Read and parse one JSONC config file.
 * @param path - file to read.
 * @returns `{ config }` or `{ error }`.
 */
export function readConfigFile(path: string): JsoncParseResult {
  if (!existsSync(path)) return { config: undefined, error: { messageText: `cannot read ${path}` } }
  return parseConfigFileTextToJson(readFileSync(path, 'utf8'))
}

/** Parse one tsconfig through the TypeScript 7 sync API. */
export function parseConfigFile(path: string): {
  readonly fileNames: string[]
  readonly outDir: string | undefined
} {
  const parsed = compiler().parseConfigFile(path)
  const outDir = parsed.options.outDir
  return {
    fileNames: parsed.fileNames,
    outDir: typeof outDir === 'string' ? outDir : undefined,
  }
}

/**
 * Syntactic diagnostics for one on-disk file already opened through this session.
 * @param file - absolute path of a source file this session has parsed.
 * @returns flattened diagnostic messages, empty when the file parses.
 */
export function syntacticDiagnostics(file: string): string[] {
  const snapshot = compiler().updateSnapshot({ openFiles: [file] })
  const project = snapshot.getDefaultProjectForFile(file)
  if (project === undefined) return [`ts7: no project for ${file}`]
  return project.program.getSyntacticDiagnostics(file).map(diagnostic =>
    flattenDiagnosticMessage(diagnostic, '\n'))
}
