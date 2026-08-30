/**
 * TypeScript 7 compiler session for Typert isolated parses and tsconfig reads.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { getNodeValue, parseTree, type ParseError } from 'jsonc-parser'
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

/**
 * Shut down the Go compiler session and kill its child process.
 * @returns nothing.
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
  // Ambient declarations reach a program through `types`/`typeRoots`, never
  // through a config's `fileNames`, so the sidecar carries the aggregate's own
  // resolved values. Without them the globals an aggregate resolves have no
  // declaration in the face program. The sidecar lives in a temp directory, so
  // default @types discovery would walk up from tmp and find nothing.
  const aggregate = parseConfigFile(aggregatePath).options
  const types = configStringArray(aggregate, 'types')
  writeFileSync(path, JSON.stringify({
    extends: baseConfigPath(aggregatePath),
    compilerOptions: {
      noEmit: true,
      typeRoots: configStringArray(aggregate, 'typeRoots') ?? [discoverTypeRoot(aggregatePath)],
      ...types === undefined ? {} : { types },
    },
    files: [...fileNames].sort(),
  }, null, 2))
  return path
}

/** Read one resolved compiler option that must be a string array. */
function configStringArray(options: object, key: string): string[] | undefined {
  const value: unknown = Reflect.get(options, key)
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) return undefined
  return value as string[]
}

/** Resolve the compiler-options base config one aggregate extends. */
function baseConfigPath(aggregatePath: string): string {
  return nearestAncestorFile(resolve(aggregatePath, '..'), 'tsconfig.base.json')
}

/**
 * Walk up from a directory until a named relative path exists, falling back
 * to that path in the starting directory when nothing matches on the way to
 * the filesystem root.
 */
function nearestAncestorFile(startDirectory: string, name: string): string {
  let directory = startDirectory
  while (true) {
    const candidate = join(directory, name)
    if (existsSync(candidate)) return candidate
    const parent = resolve(directory, '..')
    if (parent === directory) return join(startDirectory, name)
    directory = parent
  }
}

function discoverTypeRoot(aggregatePath: string): string {
  return nearestAncestorFile(resolve(aggregatePath, '..'), join('node_modules', '@types'))
}

/**
 * Read and parse one JSONC object file.
 * @param path - file to read.
 * @returns the object, or undefined when the file is missing or not an object.
 */
export function readJsoncObject(path: string): object | undefined {
  if (!existsSync(path)) return undefined
  const errors: ParseError[] = []
  const root = parseTree(readFileSync(path, 'utf8'), errors)
  if (errors.length > 0 || root === undefined) return undefined
  const value: unknown = getNodeValue(root)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value
}
/**
 * Shared TypeScript 7 API for opening configured projects.
 * @returns the session API, created on first use.
 */
export function compilerApi(): API {
  return compiler()
}

/**
 * Diagnostics the compiler reports for one tsconfig itself.
 *
 * `parseConfigFile` answers with file names alone, so a malformed config or a
 * rejected option value is silent until a project is opened over it. The
 * project is closed again: this validates configs the analysis may never open.
 * @param path - absolute tsconfig path.
 * @returns one message per diagnostic, empty when the compiler accepts it.
 */
export function configFileDiagnostics(path: string): string[] {
  // The session caches what it already read for this path, and a caller can
  // validate a config the process wrote or replaced since then. The change is
  // announced in its own snapshot: a project opened in the same update is still
  // built from the content the session held before it.
  compiler().updateSnapshot({ fileChanges: { changed: [path] } })
  const snapshot = compiler().updateSnapshot({ openProjects: [path] })
  const project = snapshot.getProject(path)
  const messages = project === undefined
    ? [`TypeScript did not open ${path}`]
    : project.program.getConfigFileParsingDiagnostics()
      .map(diagnostic => flattenDiagnosticMessageText(diagnostic, '\n'))
  compiler().updateSnapshot({ closeProjects: [path] })
  return messages
}

/**
 * Tell the compiler session an on-disk source file changed.
 * @param file - absolute path of the written file.
 * @returns nothing.
 */
export function notifyFileChanged(file: string): void {
  compiler().updateSnapshot({ fileChanges: { changed: [file] } })
}
