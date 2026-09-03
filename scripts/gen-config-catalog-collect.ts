/**
 * Walk every `packages/<group>/<pkg>` entry and build catalog entries.
 */

import { existsSync, globSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { ClassDeclaration, ParameterDeclaration } from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isClassDeclaration,
  isConstructorDeclaration,
  isIdentifier,
  isTypeReferenceNode,
} from 'typescript/unstable/ast/is'
import { pointer } from './jsdoc.ts'
import { readConfigFile } from './ts7-session.ts'
import {
  checkMemberDocs,
  collectTypeNames,
  findTypeDecl,
  loadFile,
  pasteText,
  resolveTypeName,
} from './gen-config-catalog-load.ts'
import { lookupPath, parseSchemaPath } from './gen-config-catalog-lookup.ts'
import type { CatalogEntry, FileCtx, Kind, Paste, TypeRef, World } from './gen-config-catalog-model.ts'
import { GLOBAL_TYPES, report } from './gen-config-catalog-model.ts'
import {
  applyExport,
  defaultExport,
  findInject,
  findSchemaExpr,
  walkSchemaExpr,
} from './gen-config-catalog-schema.ts'

function optionalString(record: object, key: string): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined
  const value: unknown = Reflect.get(record, key)
  return typeof value === 'string' ? value : undefined
}

function readPackageName(scanRoot: string, manifestRel: string): { pkg: string; skip: boolean } | { error: string } {
  const result = readConfigFile(resolve(scanRoot, manifestRel))
  if (result.error !== undefined) return { error: `${manifestRel} ${result.error.messageText}` }
  const config = result.config
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    return { error: `${manifestRel} is not a JSON object` }
  }
  const pkg = optionalString(config, 'name')
  if (!pkg) return { error: `${manifestRel} has no "name".` }
  const os: unknown = Reflect.get(config, 'os')
  const cpu: unknown = Reflect.get(config, 'cpu')
  if (os !== undefined && cpu !== undefined) return { pkg, skip: true }
  return { pkg, skip: false }
}

/**
 * Walk every `packages/<group>/<pkg>` entry and build the catalog entries.
 * `scanRoot` defaults to the caller-supplied fixture or repo root.
 */
export function collectConfigCatalog(scanRoot: string): CatalogEntry[] {
  const violations: string[] = []
  const cache = new Map<string, FileCtx>()
  const entries: CatalogEntry[] = []
  const pkgDirByName = new Map<string, string>()
  const manifests: { dir: string; pkg: string }[] = []
  for (const manifestRel of globSync('packages/*/*/package.json', { cwd: scanRoot }).map(path => path.split(sep).join('/')).sort()) {
    const dir = manifestRel.slice(0, -'/package.json'.length)
    const named = readPackageName(scanRoot, manifestRel)
    if ('error' in named) {
      violations.push(named.error)
      continue
    }
    if (named.skip) continue
    pkgDirByName.set(named.pkg, dir)
    manifests.push({ dir, pkg: named.pkg })
  }
  const world: World = { scanRoot, cache, pkgDirByName }

  for (const { dir, pkg } of manifests) {
    const entryRel = `${dir}/src/index.ts`
    const abs = resolve(scanRoot, entryRel)
    if (!existsSync(abs)) {
      violations.push(`${pkg}: entry ${entryRel} is missing or unreadable.`)
      continue
    }
    const ctx = loadFile(abs, entryRel, cache)
    const dflt = defaultExport(ctx)
    const apply = applyExport(ctx)
    let pluginClass: ClassDeclaration | null = null
    let configParam: ParameterDeclaration | undefined
    let kind: Kind
    let className: string | undefined
    if (dflt && isClassDeclaration(dflt)) {
      className = dflt.name?.text
      if (dflt.modifiers?.some(m => m.kind === SyntaxKind.AbstractKeyword)) {
        kind = 'seam'
      } else {
        pluginClass = dflt
        const ctor = dflt.members.find(isConstructorDeclaration)
        configParam = ctor?.parameters[1]
        kind = configParam ? 'config' : 'no-config'
      }
    } else if (dflt) {
      configParam = dflt.parameters[1]
      kind = configParam ? 'config' : 'no-config'
    } else if (apply) {
      configParam = apply.parameters[1]
      kind = configParam ? 'config' : 'no-config'
    } else {
      kind = 'library'
    }

    const entry: CatalogEntry = {
      pkg,
      dir,
      entry: entryRel,
      kind,
      inject: kind === 'library' || kind === 'seam' ? [] : findInject(ctx, pluginClass, violations),
      ...className !== undefined ? { className } : {},
    }
    entries.push(entry)
    if (kind !== 'config' || !configParam) continue
    if (!configParam.type || !isTypeReferenceNode(configParam.type) || !isIdentifier(configParam.type.typeName)) {
      violations.push(`${pkg}: config parameter type (${pointer(entryRel, ctx.sf, configParam)}) is not a plain type-name reference; declare a named config type.`)
      continue
    }
    const typeName = configParam.type.typeName.text
    entry.configTypeName = typeName
    collectPastes(pkg, ctx, typeName, cache, violations, entry)
    const schemaExpr = findSchemaExpr(ctx, pluginClass)
    if (schemaExpr) {
      const { keys, composes } = walkSchemaExpr(ctx, schemaExpr, `${pkg} (${entryRel})`, violations, world)
      entry.schemaKeys = keys
      entry.schemaComposes = composes
    } else {
      entry.schemaKeys = null
    }
  }

  const byName = new Map(entries.map(e => [e.pkg, e]))
  for (const entry of entries) {
    if (entry.kind !== 'config' || entry.schemaKeys === null || entry.schemaKeys === undefined) continue
    const seen = new Set<string>()
    const foldComposed = (e: CatalogEntry): string[] => {
      if (seen.has(e.pkg)) return []
      seen.add(e.pkg)
      const keys = [...e.schemaKeys ?? []]
      for (const composed of e.schemaComposes ?? []) {
        const target = byName.get(composed)
        if (!target) {
          violations.push(`${entry.pkg}: schema intersects '${composed}', which is not a workspace package the walk collected.`)
          continue
        }
        keys.push(...foldComposed(target))
      }
      return keys
    }
    const allKeys = foldComposed(entry)
    const mainPaste = entry.pastes?.[0]
    const mainFile = mainPaste?.source.split(':')[0]
    const mainCtx = mainFile !== undefined ? cache.get(resolve(scanRoot, mainFile)) : undefined
    const mainDecl = mainCtx && entry.configTypeName !== undefined ? findTypeDecl(mainCtx, entry.configTypeName) : null
    if (!mainCtx || !mainDecl) {
      violations.push(`${entry.pkg}: cannot locate config type '${entry.configTypeName ?? ''}' for the schema-path check.`)
      continue
    }
    for (const keyPath of allKeys) {
      if (lookupPath(world, mainCtx, mainDecl, parseSchemaPath(keyPath), new Set()) === 'missing') {
        violations.push(`${entry.pkg}: schema validates key '${keyPath}' but config type '${entry.configTypeName ?? ''}' declares no such member — the catalog paste would hide a loader-accepted field.`)
      }
    }
  }

  report(violations)
  return entries.sort((a, b) => a.pkg.localeCompare(b.pkg))
}

function collectPastes(
  pkg: string,
  ctx: FileCtx,
  typeName: string,
  cache: Map<string, FileCtx>,
  violations: string[],
  entry: CatalogEntry,
) {
  const pastes: Paste[] = []
  const refs = new Map<string, TypeRef>()
  const pastedDeclByName = new Map<string, string>()
  const queue: { name: string; from: FileCtx }[] = [{ name: typeName, from: ctx }]
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    const { name, from } = item
    const resolved = resolveTypeName(from, name, cache, violations)
    if (resolved === null) {
      violations.push(`${pkg}: config declaration references '${name}' (via ${from.rel}), which is neither declared in the package, imported, nor a known global type.`)
      continue
    }
    if ('ref' in resolved) {
      if (name === typeName) {
        violations.push(`${pkg}: config type '${name}' is imported from '${resolved.ref.specifier}'; a plugin's config type must live in its own package.`)
        continue
      }
      if (pastedDeclByName.has(name)) {
        violations.push(`${pkg}: '${name}' resolves to a package-local declaration (${pastedDeclByName.get(name) ?? ''}) in one file and an import from '${resolved.ref.specifier}' in another; rename one so the fence is unambiguous.`)
        continue
      }
      const existing = refs.get(name)
      if (existing && (existing.specifier !== resolved.ref.specifier || existing.imported !== resolved.ref.imported)) {
        violations.push(`${pkg}: '${name}' is imported from both '${existing.specifier}' (${existing.imported}) and '${resolved.ref.specifier}' (${resolved.ref.imported}) across the pasted closure; disambiguate the aliases.`)
        continue
      }
      refs.set(name, resolved.ref)
      continue
    }
    const declKey = pointer(resolved.ctx.rel, resolved.ctx.sf, resolved.decl)
    const prior = pastedDeclByName.get(name)
    if (prior === declKey) continue
    if (prior !== undefined) {
      violations.push(`${pkg}: type name '${name}' resolves to two different declarations (${prior} and ${declKey}) across the pasted closure; rename one — a verbatim fence cannot carry two same-named declarations.`)
      continue
    }
    if (refs.has(name)) {
      violations.push(`${pkg}: '${name}' resolves to an import from '${refs.get(name)?.specifier ?? ''}' in one file and a package-local declaration (${declKey}) in another; rename one so the fence is unambiguous.`)
      continue
    }
    pastedDeclByName.set(name, declKey)
    pastes.push({ text: pasteText(resolved.ctx, resolved.decl), source: declKey })
    checkMemberDocs(resolved.ctx, resolved.decl, violations)
    const names = new Set<string>()
    collectTypeNames(resolved.decl, names)
    for (const n of names) {
      if (GLOBAL_TYPES.has(n)) continue
      queue.push({ name: n, from: resolved.ctx })
    }
  }
  entry.pastes = pastes
  entry.refs = [...refs.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}
