/**
 * Config-catalog entry types and globals for {@link ./gen-config-catalog.ts}.
 */

import type {
  EnumDeclaration,
  InterfaceDeclaration,
  SourceFile,
  TypeAliasDeclaration,
} from 'typescript/unstable/ast'

/** TypeScript/Node global type names a config declaration may reference
 * without importing; never treated as unresolved. */
export const GLOBAL_TYPES = new Set([
  'Array', 'ReadonlyArray', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
  'Promise', 'Map', 'Set', 'Date', 'Error', 'RegExp', 'Exclude', 'Extract', 'NonNullable',
  'ReturnType', 'Parameters', 'AbortSignal', 'URL', 'Buffer', 'NodeJS', 'Iterable', 'AsyncIterable',
])

/** How a package classifies for the catalog. */
export type Kind = 'config' | 'no-config' | 'seam' | 'library'

/** One name a pasted declaration references but the paste does not contain. */
export interface TypeRef {
  /** The name as it appears in the pasted text (the local import alias). */
  alias: string
  /** The name the source module exports it under (pre-alias). */
  imported: string
  /** The import module specifier (package name or external module). */
  specifier: string
}

/** One verbatim declaration paste. */
export interface Paste {
  /** Full source text: leading JSDoc (when present) through the closing token. */
  text: string
  /** Source pointer `packages/…/file.ts:line` of the declaration. */
  source: string
}

/** One package's catalog entry. */
export interface CatalogEntry {
  /** npm package name, e.g. `@deepseek-ai/dsh-agent-loop`. */
  pkg: string
  /** Repo-relative package dir, e.g. `packages/core/agent-loop`. */
  dir: string
  /** Repo-relative entry file, `<dir>/src/index.ts`. */
  entry: string
  kind: Kind
  /** Service keys the plugin `inject`s (empty when none declared). */
  inject: string[]
  /** Seam/service class name (kinds `seam` and class-based plugins). */
  className?: string
  /** Name of the config type (kind `config`). */
  configTypeName?: string
  /** Verbatim declaration pastes, the config type first (kind `config`). */
  pastes?: Paste[]
  /** References the pastes leave unresolved locally (kind `config`). */
  refs?: TypeRef[]
  /** Top-level keys and nested key paths (`agents[].id`) of the runtime
   * schema, `null` when no schema exists (kind `config`). */
  schemaKeys?: string[] | null
  /** Package names whose schemas an intersect composes (kind `config`). */
  schemaComposes?: string[]
}

/** A parsed source file plus its import map (local name → origin). */
export interface FileCtx {
  abs: string
  rel: string
  text: string
  sf: SourceFile
  /** Local binding name → `{ imported, specifier }`; default imports record
   * `imported: 'default'`. */
  imports: Map<string, { imported: string; specifier: string }>
}

/** A type declaration a paste can contain. */
export type TypeDecl = InterfaceDeclaration | TypeAliasDeclaration | EnumDeclaration

/** Cross-file resolution context for the schema-path check. */
export interface World {
  scanRoot: string
  cache: Map<string, FileCtx>
  /** Workspace package name → repo-relative package dir. */
  pkgDirByName: Map<string, string>
}

/** How a schema key path fared against the declared config type. */
export type PathLookup = 'found' | 'missing' | 'unknown'

/** One step of a schema key path: a named member, or an array-element hop. */
export type PathStep = { member: string } | { array: true }

/** Throw one aggregate error for every violation the walk collected. */
export function report(violations: string[]) {
  if (violations.length === 0) return
  throw new Error(
    `gen-config-catalog: ${String(violations.length)} violation(s):\n`
    + violations.map(v => `  ${v}`).join('\n'),
  )
}
