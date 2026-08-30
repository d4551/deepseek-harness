/**
 * Enforce JSDoc on every non-vendored package export. Functions and public
 * class methods require parameter and non-void return documentation; exported
 * declarations require description prose.
 */

import { existsSync, globSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { API } from 'typescript/unstable/sync'
import { SymbolFlags, type Checker } from 'typescript/unstable/sync'
import type { SourceFile } from 'typescript/unstable/ast'
import { checkScope } from './export-jsdoc-scope.ts'
import { declarationName, type Walk } from './export-jsdoc-contract.ts'
import { readConfigFile } from './ts7-session.ts'
import { TypeScriptProject } from './ts-project.ts'

const root = resolve(import.meta.dirname, '..')

function exportedTargets(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (value === null || typeof value !== 'object') return []
  return Object.values(value).flatMap(entry =>
    exportedTargets(typeof entry === 'string' || entry === null || typeof entry === 'object' ? entry : undefined),
  )
}

function sourceEntry(target: string): string | undefined {
  if (target.startsWith('./lib/types/') && target.endsWith('.d.ts')) {
    return `src/${target.slice('./lib/types/'.length, -'.d.ts'.length)}.ts`
  }
  if (target.startsWith('./lib/') && target.endsWith('.js')) {
    return `src/${target.slice('./lib/'.length, -'.js'.length)}.ts`
  }
  return undefined
}

function optionalExports(record: object): object | undefined {
  if (!Object.hasOwn(record, 'exports')) return undefined
  const value: unknown = Reflect.get(record, 'exports')
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  return value
}

function restrictedPublicNames(
  scanRoot: string,
  rels: readonly string[],
  getFile: (abs: string) => SourceFile | undefined,
  checker: Checker,
): { restrictedPackages: Set<string>; namesByFile: Map<string, Set<string>> } {
  const restrictedPackages = new Set<string>()
  const namesByFile = new Map<string, Set<string>>()
  const packages = new Set(rels.map(rel => rel.split('/').slice(0, 3).join('/')))
  for (const packageDir of packages) {
    const manifestPath = resolve(scanRoot, packageDir, 'package.json')
    if (!existsSync(manifestPath)) continue
    const parsed = readConfigFile(manifestPath)
    if (parsed.error !== undefined || parsed.config === null || typeof parsed.config !== 'object' || Array.isArray(parsed.config)) {
      continue
    }
    const exportsField = optionalExports(parsed.config)
    if (exportsField === undefined || Object.hasOwn(exportsField, './src/*')) continue
    restrictedPackages.add(packageDir)
    const entries = new Set(exportedTargets(exportsField).flatMap((target) => {
      const entry = sourceEntry(target)
      return entry ? [`${packageDir}/${entry}`] : []
    }))
    for (const entry of entries) {
      const source = getFile(resolve(scanRoot, entry))
      const moduleSymbol = source === undefined ? undefined : checker.getSymbolAtLocation(source)
      if (source === undefined || moduleSymbol === undefined) continue
      for (const exported of checker.getExportsOfModule(moduleSymbol)) {
        const target = (exported.flags & SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(exported) : exported
        for (const handle of target.declarations) {
          const declaration = handle.resolve()
          if (declaration === undefined) continue
          const name = declarationName(declaration)
          const file = declaration.getSourceFile().fileName
          const rel = relative(scanRoot, file).split(sep).join('/')
          if (name === undefined || !rel.startsWith(`${packageDir}/src/`)) continue
          namesByFile.set(rel, new Set([...(namesByFile.get(rel) ?? []), name]))
        }
      }
    }
  }
  return { restrictedPackages, namesByFile }
}

function walkFiles(
  scanRoot: string,
  rels: readonly string[],
  getFile: (abs: string) => SourceFile | undefined,
  checker: Checker,
): string[] {
  const violations: string[] = []
  const { restrictedPackages, namesByFile } = restrictedPublicNames(scanRoot, rels, getFile, checker)
  for (const rel of rels) {
    const sf = getFile(resolve(scanRoot, rel))
    if (sf === undefined) continue
    const packageDir = rel.split('/').slice(0, 3).join('/')
    const allowedNames = restrictedPackages.has(packageDir) ? namesByFile.get(rel) ?? new Set<string>() : undefined
    const w: Walk = { rel, sf, text: sf.text, checker, violations }
    checkScope(sf.statements, '', w, sf.isDeclarationFile && sf.externalModuleIndicator === undefined, allowedNames)
  }
  return violations
}

/**
 * Walk every non-vendored package source file and collect JSDoc-completeness
 * violations for its module-level exports.
 * @param scanRoot - the repo root to scan; tests pass a fixture dir.
 * @returns every violation, in file order, one human-readable line each.
 */
export function collectExportJsdocViolations(scanRoot: string = root): string[] {
  const rels = globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot })
    .map(path => path.split(sep).join('/'))
    .sort()
  if (existsSync(resolve(scanRoot, 'tsconfig.host.json'))) {
    const project = new TypeScriptProject(scanRoot, 'host')
    const getFile = (abs: string): SourceFile | undefined => project.program.getSourceFile(abs)
    const violations = walkFiles(scanRoot, rels, getFile, project.checker)
    project.close()
    return violations
  }
  const files = rels.map(rel => resolve(scanRoot, rel))
  const api = new API()
  const snapshot = files.length === 0 ? undefined : api.updateSnapshot({ openFiles: files })
  const getFile = (abs: string): SourceFile | undefined => {
    const project = snapshot?.getDefaultProjectForFile(abs)
    return project?.program.getSourceFile(abs)
  }
  const first = files[0]
  const checker = first === undefined ? undefined : snapshot?.getDefaultProjectForFile(first)?.checker
  const violations = checker === undefined ? [] : walkFiles(scanRoot, rels, getFile, checker)
  api.close()
  return violations
}

function main(): void {
  const violations = collectExportJsdocViolations()
  if (violations.length === 0) {
    process.stdout.write('verify-export-jsdoc: every exported name in each package API is documented.\n')
    return
  }
  process.stderr.write(`verify-export-jsdoc: ${String(violations.length)} JSDoc completeness violation(s) (see AGENTS.md):\n`)
  for (const v of violations) process.stderr.write(`  ${v}\n`)
  process.exit(1)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  main()
}
