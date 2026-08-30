/**
 * TypeScript 7 compiler session for Typert isolated parses and tsconfig reads.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parse as parseJsonc, type ParseError } from 'jsonc-parser'
import { API } from 'typescript/unstable/sync'
import type { Diagnostic } from 'typescript/unstable/sync'
import type { Node, SourceFile } from 'typescript/unstable/ast'

let api: API | undefined
let textRoot: string | undefined
let textSerial = 0
let configRoot: string | undefined
let configSerial = 0

function compiler(): API {
  api ??= new API()
  return api
}

/** Shut down the Go compiler session. */
export function closeCompiler() {
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
  const snapshot = compiler().updateSnapshot({ openFiles: [file] })
  const project = snapshot.getDefaultProjectForFile(file)
  if (project === undefined) throw new Error(`ts7: no project for ${file}`)
  const sourceFile = project.program.getSourceFile(file)
  if (sourceFile === undefined) throw new Error(`ts7: missing source file ${file}`)
  return sourceFile
}

/**
 * Print one node bound to the project that owns `file`.
 * @param file - on-disk path anchoring the owning project.
 * @param node - node from that project's program or a factory update of one.
 * @returns printed TypeScript text.
 */
export function printInFile(file: string, node: Node): string {
  const snapshot = compiler().updateSnapshot({ openFiles: [file] })
  const project = snapshot.getDefaultProjectForFile(file)
  if (project === undefined) throw new Error(`ts7: no project for ${file}`)
  return project.emitter.printNode(node)
}

/**
 * Parse source text. Matching on-disk contents reuse the real path; other
 * text is written to a process-temp file the snapshot can open.
 * @param fileName - path used as the source-file name.
 * @param text - file contents.
 * @returns the bound source file.
 */
export function createSourceFile(fileName: string, text: string): SourceFile {
  const file = resolve(fileName)
  if (existsSync(file) && readFileSync(file, 'utf8') === text) return parsePath(file)
  textRoot ??= mkdtempSync(join(tmpdir(), 'dsh-typert-ts7-'))
  textSerial += 1
  const suffix = basename(fileName) || 'input.ts'
  const path = join(textRoot, `${String(textSerial)}-${suffix}`)
  writeFileSync(path, text)
  return parsePath(path)
}

/**
 * Flatten a TypeScript 7 diagnostic or a string into one message.
 * @param messageText - diagnostic, chain, or already-flat string.
 * @param separator - inserted between chain entries.
 * @returns the flattened message.
 */
export function flattenDiagnosticMessageText(
  messageText: string | Diagnostic,
  separator: string,
): string {
  if (typeof messageText === 'string') return messageText
  const chain = messageText.messageChain
  if (chain === undefined || chain.length === 0) return messageText.text
  return [messageText.text, ...chain.map(entry => flattenDiagnosticMessageText(entry, separator))].join(separator)
}

/**
 * Parse one tsconfig through the TypeScript 7 sync API.
 * @param path - tsconfig path.
 * @returns file names and raw compiler options.
 */
export function parseConfigFile(path: string): {
  readonly fileNames: string[]
  readonly options: object
} {
  const parsed = compiler().parseConfigFile(path)
  return { fileNames: parsed.fileNames, options: parsed.options }
}

/**
 * Write one temporary tsconfig that opens a single program over explicit
 * files, extending the aggregate's base compiler-options config. The
 * aggregate itself is a solution config: extending it would make the
 * compiler follow its project references and pull every referenced project
 * — spec files included — into the program. Session-owned temp artifacts
 * live beside the session's text root and outlive the call.
 * @param aggregatePath - absolute face-aggregate tsconfig; its `extends`
 * target supplies the program's compiler options.
 * @param fileNames - absolute source paths the program must contain.
 * @returns written sidecar config path.
 */
export function writeProgramConfig(aggregatePath: string, fileNames: readonly string[]): string {
  configRoot ??= mkdtempSync(join(tmpdir(), 'dsh-typert-ts7-'))
  configSerial += 1
  const path = join(configRoot, `program-${String(configSerial)}.json`)
  writeFileSync(path, JSON.stringify({
    extends: baseConfigPath(aggregatePath),
    compilerOptions: {
      noEmit: true,
      // The sidecar lives in a temp directory, so @types discovery would walk
      // up from tmp and find nothing; pin typeRoots where the aggregate finds them.
      typeRoots: [discoverTypeRoot(aggregatePath)],
    },
    files: [...fileNames].sort(),
  }, null, 2))
  return path
}

/** Resolve the compiler-options base config one aggregate extends. */
function baseConfigPath(aggregatePath: string): string {
  const config = readJsoncObject(aggregatePath)
  const extended = config === undefined ? undefined : Reflect.get(config, 'extends')
  const directory = resolve(aggregatePath, '..')
  if (typeof extended === 'string' && extended.endsWith('.json')) {
    return resolve(directory, extended)
  }
  return join(directory, 'tsconfig.base.json')
}

function discoverTypeRoot(aggregatePath: string): string {
  let directory = resolve(aggregatePath, '..')
  while (true) {
    const candidate = join(directory, 'node_modules', '@types')
    if (existsSync(candidate)) return candidate
    const parent = resolve(directory, '..')
    if (parent === directory) return join(resolve(aggregatePath, '..'), 'node_modules', '@types')
    directory = parent
  }
}

/**
 * Read and parse one JSONC object file.
 * @param path - file to read.
 * @returns the object, or undefined when the file is missing or not an object.
 */
export function readJsoncObject(path: string): object | undefined {
  if (!existsSync(path)) return undefined
  const errors: ParseError[] = []
  const config = parseJsonc(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true })
  if (errors.length > 0) return undefined
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return undefined
  return config
}

/** Shared TypeScript 7 API for opening configured projects. */
export function compilerApi(): API {
  return compiler()
}

/**
 * Tell the compiler session an on-disk source file changed.
 * @param file - absolute path of the written file.
 */
export function notifyFileChanged(file: string) {
  compiler().updateSnapshot({ fileChanges: { changed: [file] } })
}
