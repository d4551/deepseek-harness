/**
 * AST helpers for the client slot surface: the `SlotMap` declaration merges
 * that type every slot, and the `slots.register` call sites that say who
 * already occupies one. Both readings are lexical (no type-checker program):
 * the client catalog generator consumes them, and the same scan doubles as its
 * own exhaustiveness backstop because it reads every source file rather than a
 * reachable-export closure.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Expression, ModuleBlock, Node, SourceFile } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isCallExpression,
  isIdentifier,
  isInterfaceDeclaration,
  isModuleBlock,
  isModuleDeclaration,
  isObjectLiteralExpression,
  isPropertyAccessExpression,
  isPropertySignatureDeclaration,
  isStringLiteral,
  isTypeAliasDeclaration,
  isTypeLiteralNode,
} from 'typescript/unstable/ast/is'
import {
  childKeys, collapse, componentText, declarationText, jsDocOf, lineOf, literalMember, memberTypeText, stringProperty,
} from './slot-walk-text.ts'
import { parsePaths } from './ts7-session.ts'

/** The module whose `SlotMap` / standard-kit interfaces every slot owner merges into. */
const SLOTS_MODULE = '@deepseek-ai/dsh-client-ui-slots'

/** Cheap textual prefilter for a slot-contract merge, quote-style agnostic. */
const MERGE_HEAD = /declare module ['"]@deepseek-ai\/dsh-client-ui-slots['"]/

/** Cheap textual prefilter for a registration call site. */
const REGISTER_HEAD = /\.register\(/

/** One `SlotMap` member: the slot's contract as its owning package declares it. */
export interface SlotDeclaration {
  /** SlotMap key, e.g. `settings.section`. */
  key: string
  /** Cardinality literal (`single` / `list` / `keyed` / `chain`), or '' when not a literal. */
  kind: string
  /** Data-scope literal (`root` / `session` / `session-maybe`), or '' when not a literal. */
  scope: string
  /** Type name of the owner-supplied props share, absent when the slot declares none. */
  ownerType?: string
  /** Source text of the `keyProps` member (keyed slots), absent otherwise. */
  keyProps?: string
  /** Source text of the `hookContext` member, absent otherwise. */
  hookContext?: string
  /** Type name of the slot-level inject face, absent when the slot declares none. */
  injectType?: string
  /** The member's JSDoc with container indentation removed, '' when undocumented. */
  jsDoc: string
  /** Workspace package that declares the contract. */
  package: string
  /** Source pointer `packages/…/file.ts:line`. */
  source: string
}

/** One `slots.register({ name, … }, Component)` call site. */
export interface SlotRegistration {
  /** Target SlotMap key the entry contributes into. */
  key: string
  /** Workspace package that registers the entry. */
  package: string
  /** Component argument as written (identifier, or a trimmed expression). */
  component: string
  /** `id` literal of a list entry, absent otherwise. */
  id?: string
  /** `key` literal of a keyed entry, absent otherwise. */
  entryKey?: string
  /** SlotMap keys this registration declares as children (they exist while it is mounted). */
  children: string[]
  /** Source pointer `packages/…/file.ts:line`. */
  source: string
}

/** One exported type declaration, retained with its JSDoc for catalog projection. */
export interface TypeDeclaration {
  /** Declared name. */
  name: string
  /** Full declaration text INCLUDING its JSDoc (member docs are the teaching text). */
  text: string
  /** Source pointer `packages/…/file.ts:line`. */
  source: string
}

/** One scanned source file with the artifacts the catalog reads from it. */
export interface ScannedFile {
  /** Repo-relative, `/`-normalized path. */
  rel: string
  /** Workspace package name that owns the file. */
  package: string
  /** Parsed source file. */
  sf: SourceFile
}

/**
 * Parse every file matching `patterns`, keeping the ones that carry a slot
 * contract merge or a registration call. Files without either are skipped so
 * the scan stays cheap over the whole workspace.
 * @param scanRoot - repository root the patterns resolve against.
 * @param patterns - glob(s) selecting the TypeScript/TSX files to scan.
 * @returns one entry per interesting file, in path order.
 */
export function scanSlotFiles(scanRoot: string, patterns: readonly string[]): ScannedFile[] {
  const names = new Map<string, string>()
  const selected: { rel: string; abs: string }[] = []
  const rels = [...new Set(patterns.flatMap(pattern => globSync(pattern, { cwd: scanRoot }))
    .map(path => path.split(sep).join('/')))].sort()
  for (const rel of rels) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!MERGE_HEAD.test(text) && !REGISTER_HEAD.test(text)) continue
    selected.push({ rel, abs })
  }
  const parsed = parsePaths(selected.map(entry => entry.abs))
  return selected.map((entry) => {
    const sf = parsed.get(entry.abs)
    if (sf === undefined) throw new Error(`ts7: missing source file ${entry.abs}`)
    return {
      rel: entry.rel,
      package: packageNameOf(scanRoot, entry.rel, names),
      sf,
    }
  })
}

/**
 * Index every exported type declaration of the scanned packages, keeping JSDoc.
 * The catalog resolves owner-props and inject-face shapes through this index
 * instead of a type-checker program: the declaration text with its member
 * documentation IS the teaching material a registrant needs.
 * @param scanRoot - repository root the patterns resolve against.
 * @param patterns - glob(s) selecting the TypeScript/TSX files to index.
 * @returns name → declaration, with names declared more than once dropped as ambiguous.
 */
export function indexExportedTypes(scanRoot: string, patterns: readonly string[]): Map<string, TypeDeclaration> {
  const index = new Map<string, TypeDeclaration>()
  const ambiguous = new Set<string>()
  const rels = [...new Set(patterns.flatMap(pattern => globSync(pattern, { cwd: scanRoot }))
    .map(path => path.split(sep).join('/')))].sort()
  const absByRel = new Map(rels.map(rel => [rel, resolve(scanRoot, rel)]))
  const parsed = parsePaths([...absByRel.values()])
  for (const rel of rels) {
    const abs = absByRel.get(rel)
    if (abs === undefined) continue
    const sf = parsed.get(abs)
    if (sf === undefined) throw new Error(`ts7: missing source file ${abs}`)
    for (const statement of sf.statements) {
      if (!isInterfaceDeclaration(statement) && !isTypeAliasDeclaration(statement)) continue
      if (!statement.modifiers?.some(modifier => modifier.kind === SyntaxKind.ExportKeyword)) continue
      const name = statement.name.text
      if (index.has(name)) {
        ambiguous.add(name)
        continue
      }
      index.set(name, {
        name,
        text: declarationText(statement, sf),
        source: `${rel}:${String(lineOf(sf, statement))}`,
      })
    }
  }
  for (const name of ambiguous) index.delete(name)
  return index
}

/**
 * Read every `SlotMap` member declared in one scanned file.
 * @param file - a file returned by {@link scanSlotFiles}.
 * @returns the declared slots, in source order.
 */
export function slotDeclarations(file: ScannedFile): SlotDeclaration[] {
  const out: SlotDeclaration[] = []
  for (const body of slotModuleBodies(file.sf)) {
    for (const statement of body.statements) {
      if (!isInterfaceDeclaration(statement) || statement.name.text !== 'SlotMap') continue
      for (const member of statement.members) {
        if (!isPropertySignatureDeclaration(member)) continue
        const key = isStringLiteral(member.name) || isIdentifier(member.name)
          ? member.name.text
          : member.name.getText(file.sf)
        const entry = isTypeLiteralNode(member.type) ? member.type : undefined
        const ownerType = memberTypeText(entry, 'owner', file.sf)
        const keyProps = memberTypeText(entry, 'keyProps', file.sf)
        const hookContext = memberTypeText(entry, 'hookContext', file.sf)
        const injectType = memberTypeText(entry, 'inject', file.sf)
        out.push({
          key,
          kind: literalMember(entry, 'kind'),
          scope: literalMember(entry, 'scope'),
          ...ownerType === undefined ? {} : { ownerType },
          ...keyProps === undefined ? {} : { keyProps },
          ...hookContext === undefined ? {} : { hookContext },
          ...injectType === undefined ? {} : { injectType },
          jsDoc: jsDocOf(member, file.sf),
          package: file.package,
          source: `${file.rel}:${String(lineOf(file.sf, member))}`,
        })
      }
    }
  }
  return out
}

/**
 * Read every registration call site in one scanned file: which slot it
 * occupies, with which component and cell identity, and which child slots it
 * declares. A call whose `name` is not a string literal is skipped — the
 * shipped composition always names its target literally, and a computed name
 * carries no catalog fact.
 * @param file - a file returned by {@link scanSlotFiles}.
 * @returns the registrations, in source order.
 */
export function slotRegistrations(file: ScannedFile): SlotRegistration[] {
  const out: SlotRegistration[] = []
  const visit = (node: Node): void => {
    if (isCallExpression(node)
      && isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'register'
      && isSlotsReceiver(node.expression.expression, file.sf)
      && node.arguments.length >= 1) {
      const options = node.arguments[0]
      if (options !== undefined && isObjectLiteralExpression(options)) {
        const key = stringProperty(options, 'name')
        if (key !== undefined) {
          const id = stringProperty(options, 'id')
          const entryKey = stringProperty(options, 'key')
          out.push({
            key,
            package: file.package,
            component: componentText(node.arguments[1], file.sf),
            ...id === undefined ? {} : { id },
            ...entryKey === undefined ? {} : { entryKey },
            children: childKeys(options),
            source: `${file.rel}:${String(lineOf(file.sf, node))}`,
          })
        }
      }
    }
    node.forEachChild(visit)
  }
  visit(file.sf)
  return out
}

/**
 * Read one standard-kit interface's members from the scanned files: the props
 * a slot component receives for free from the framework at a given scope.
 * @param files - scanned files to search.
 * @param interfaceName - `GlobalStandardProps`, `SessionStandardProps`, or `SessionMaybeStandardProps`.
 * @returns `member: type` texts in declaration order, merged across declaring files.
 */
export function standardKitMembers(files: readonly ScannedFile[], interfaceName: string): string[] {
  const out: string[] = []
  for (const file of files) {
    for (const body of slotModuleBodies(file.sf)) {
      for (const statement of body.statements) {
        if (!isInterfaceDeclaration(statement) || statement.name.text !== interfaceName) continue
        for (const member of statement.members) {
          if (!isPropertySignatureDeclaration(member)) continue
          const type = member.type.getText(file.sf)
          out.push(`${member.name.getText(file.sf)}${member.postfixToken?.kind === SyntaxKind.QuestionToken ? '?' : ''}: ${collapse(type)}`)
        }
      }
    }
  }
  return out
}

/**
 * Names in the type index that seed texts mention, word-bounded — ONE level, not
 * a transitive closure. The catalog expands an owner-props contract exactly one
 * step: the owner interface carries the interaction protocol in its own member
 * documentation, while the shapes its fields reference belong to the subsystems
 * that own them and would otherwise drag the entire session model into a single
 * slot's report.
 * @param seeds - declaration or signature texts to search.
 * @param index - the type index from {@link indexExportedTypes}.
 * @returns the mentioned names, sorted.
 */
export function referencedTypeNames(
  seeds: readonly string[],
  index: ReadonlyMap<string, TypeDeclaration>,
): string[] {
  const found: string[] = []
  for (const name of index.keys()) {
    const pattern = new RegExp(`\\b${name}\\b`)
    if (seeds.some(text => pattern.test(text))) found.push(name)
  }
  return found.sort()
}

/**
 * Resolve declarations by name, dropping names the index does not hold.
 * @param names - type names to resolve.
 * @param index - the type index from {@link indexExportedTypes}.
 * @returns the resolved declarations, sorted by name.
 */
export function declaredTypes(
  names: readonly string[],
  index: ReadonlyMap<string, TypeDeclaration>,
): TypeDeclaration[] {
  return [...names]
    .flatMap(name => index.get(name) ?? [])
    .sort((left, right) => left.name.localeCompare(right.name))
}

/** Every slot-contract module block in one file, in source order. */
function slotModuleBodies(sf: SourceFile): ModuleBlock[] {
  const bodies: ModuleBlock[] = []
  for (const statement of sf.statements) {
    if (!isModuleDeclaration(statement) || !isStringLiteral(statement.name)) continue
    if (statement.name.text !== SLOTS_MODULE) continue
    if (statement.body !== undefined && isModuleBlock(statement.body)) bodies.push(statement.body)
  }
  return bodies
}

/**
 * Whether a `X.register(...)` receiver is the slots service. Every other
 * registry in the repo (`ctx.tools`, `ctx.commands`, `ctx.settings`, …) also
 * takes an options object with a `name`, so the receiver is what separates a
 * slot occupancy fact from an unrelated registration.
 */
function isSlotsReceiver(receiver: Expression, sf: SourceFile): boolean {
  const text = receiver.getText(sf)
  return text === 'slots' || text.endsWith('.slots')
}

/** The workspace package name owning a repo-relative file, memoized per package root. */
function packageNameOf(scanRoot: string, rel: string, cache: Map<string, string>): string {
  let dir = dirname(resolve(scanRoot, rel))
  while (dir.length > scanRoot.length) {
    const cached = cache.get(dir)
    if (cached !== undefined) return cached
    const manifestPath = join(dir, 'package.json')
    if (!existsSync(manifestPath)) {
      dir = dirname(dir)
      continue
    }
    const manifestText = readFileSync(manifestPath, 'utf8')
    const nameMatch = /"name"\s*:\s*"([^"]+)"/.exec(manifestText)
    if (nameMatch !== null && nameMatch[1] !== undefined) {
      cache.set(dir, nameMatch[1])
      return nameMatch[1]
    }
    dir = dirname(dir)
  }
  return '(unknown package)'
}
