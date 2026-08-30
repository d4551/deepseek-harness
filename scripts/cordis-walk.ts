/**
 * AST helpers shared by the Cordis generators: locate the Cordis module merge
 * in a source file and enumerate the `interface Context` keys it declares.
 * The vendored core API projector consumes the merge body; the per-subsystem
 * region generator's exhaustiveness backstop consumes the key scan.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ModuleBlock, SourceFile } from 'typescript/unstable/ast'
import {
  isIdentifier,
  isInterfaceDeclaration,
  isMethodSignatureDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isPropertySignatureDeclaration,
  isStringLiteral,
} from 'typescript/unstable/ast/is'
import { parsePath } from './ts7-session.ts'

/** Cheap textual prefilter for a cordis module merge, quote-style agnostic
 * (the AST match below reads `stmt.name.text` and never sees the quotes). */
const MERGE_HEAD = /declare module ['"](?:@deepseek-ai\/cordis|\.\/context\.ts)['"]/

/**
 * Parse every file matching `patterns` (repo-relative, sorted, `/`-normalized)
 * that textually contains a cordis module merge, yielding one entry per merge
 * BLOCK — a file may legally hold several `declare module '@deepseek-ai/cordis'` blocks
 * (the Typert analyzer reads them all), so the exhaustiveness scan must too.
 * Files without a merge are skipped.
 * @param scanRoot - Repository root the patterns are resolved against.
 * @param patterns - Glob(s) selecting the TypeScript files to scan.
 * @returns One entry per cordis module block, in path then source order.
 */
export function contextMergeFiles(
  scanRoot: string,
  patterns: string | readonly string[],
): { rel: string; sf: SourceFile; text: string; body: ModuleBlock }[] {
  const out: { rel: string; sf: SourceFile; text: string; body: ModuleBlock }[] = []
  const list = typeof patterns === 'string' ? [patterns] : [...patterns]
  const rels = [...new Set(list.flatMap(pattern => globSync(pattern, { cwd: scanRoot }).map(s => s.split(sep).join('/'))))].sort()
  for (const rel of rels) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!MERGE_HEAD.test(text)) continue
    const sf = parsePath(abs)
    for (const body of cordisModuleBodies(sf)) out.push({ rel, sf, text, body })
  }
  return out
}

/** Every cordis module-merge body in `sf`: `declare module '@deepseek-ai/cordis'` (harness
 * packages) or `declare module './context.ts'` (vendor core), in source order.
 * Module-local: consumers walk blocks through {@link contextMergeFiles}. */
function cordisModuleBodies(sf: SourceFile): ModuleBlock[] {
  const bodies: ModuleBlock[] = []
  for (const stmt of sf.statements) {
    if (!isModuleDeclaration(stmt) || !isStringLiteral(stmt.name)) continue
    if (stmt.name.text !== '@deepseek-ai/cordis' && stmt.name.text !== './context.ts') continue
    if (stmt.body !== undefined && isModuleBlock(stmt.body)) bodies.push(stmt.body)
  }
  return bodies
}

/** The FIRST cordis module-merge body in `sf`, or null without one — for the
 * vendor core-API renderer whose input files carry exactly one merge; the
 * exhaustiveness scan uses {@link cordisModuleBodies} to read them all. */
export function cordisModuleBody(sf: SourceFile): ModuleBlock | null {
  return cordisModuleBodies(sf)[0] ?? null
}

/**
 * Every `key: Type` property a `declare module '@deepseek-ai/cordis'` Context merge
 * declares in one module body.
 * @param body - The cordis module augmentation block.
 * @param sf - Owning source file (for text extraction).
 * @returns key → declared type-name text, in declaration order.
 */
export function contextKeyMap(body: ModuleBlock, sf: SourceFile): Map<string, string> {
  const keyToType = new Map<string, string>()
  for (const stmt of body.statements) {
    if (!isInterfaceDeclaration(stmt) || stmt.name.text !== 'Context') continue
    for (const member of stmt.members) {
      // TS7 declares PropertySignatureDeclaration.type non-optional; an unannotated member parses with none.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (!isPropertySignatureDeclaration(member) || member.type === undefined) continue
      keyToType.set(member.name.getText(sf), member.type.getText(sf))
    }
  }
  return keyToType
}

/**
 * Every event name a `declare module '@deepseek-ai/cordis'` Events merge declares in one
 * module body. Names are the literal member keys (`'agent/created'`), read
 * from method and property members alike so a declaration form the projector
 * would reject still enters the exhaustiveness scan.
 * @param body - The cordis module augmentation block.
 * @param sf - Owning source file (for computed-name text extraction).
 * @returns Declared event names, in declaration order.
 */
export function eventNameList(body: ModuleBlock, sf: SourceFile): string[] {
  const names: string[] = []
  for (const stmt of body.statements) {
    if (!isInterfaceDeclaration(stmt) || stmt.name.text !== 'Events') continue
    for (const member of stmt.members) {
      if (!isMethodSignatureDeclaration(member) && !isPropertySignatureDeclaration(member)) continue
      names.push(isStringLiteral(member.name) || isIdentifier(member.name)
        ? member.name.text
        : member.name.getText(sf))
    }
  }
  return names
}
