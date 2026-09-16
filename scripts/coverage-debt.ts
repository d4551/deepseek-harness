/** Validate complete package-source coverage with unconditional per-file thresholds. */
import { globSync, readFileSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { parse } from '@babel/parser'
import * as t from '@babel/types'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']

/** All authored JavaScript and TypeScript package sources, including module entrypoints. */
export const COVERAGE_SOURCE_GLOB = `packages/*/*/src/**/*.{${SOURCE_EXTENSIONS.join(',')}}`

/**
 * Discover package source files independently of coverage configuration.
 * @param root - Repository root.
 * @returns Sorted repository-relative paths; an empty corpus throws.
 */
export function coverageSourceFiles(root: string = ROOT): string[] {
  const files = new Set<string>()
  for (const extension of SOURCE_EXTENSIONS) {
    for (const entry of globSync(`packages/*/*/src/**/*.${extension}`, { cwd: root, withFileTypes: true })) {
      const path = join(entry.parentPath, entry.name)
      if (entry.isFile() || (entry.isSymbolicLink() && statSync(path).isFile())) {
        files.add(relative(root, path).split(sep).join('/'))
      }
    }
  }
  if (files.size === 0) throw new Error('coverage-debt: no package source files found')
  return [...files].sort()
}

function objectProperties(node: t.Node | undefined, label: string): Map<string, t.Node> {
  if (!t.isObjectExpression(node)) throw new Error(`${label} must be an object literal`)
  const properties = new Map<string, t.Node>()
  for (const property of node.properties) {
    if (!t.isObjectProperty(property) || property.computed) {
      throw new Error(`${label} must use explicit properties without spreads or computed keys`)
    }
    const key = t.isIdentifier(property.key) ? property.key.name
      : t.isStringLiteral(property.key) ? property.key.value : undefined
    if (key === undefined || properties.has(key)) throw new Error(`${label} has an invalid or duplicate property`)
    properties.set(key, property.value)
  }
  return properties
}

function sourceInclude(node: t.Node | undefined, imports: ReadonlySet<string>): boolean {
  if (!t.isArrayExpression(node) || node.elements.length !== 1) return false
  const entry = node.elements[0]
  return t.isStringLiteral(entry) ? entry.value === COVERAGE_SOURCE_GLOB
    : t.isIdentifier(entry) && imports.has(entry.name)
}

function valueImports(program: t.Program, module: string, imported: string): Set<string> {
  const names = new Set<string>()
  for (const statement of program.body) {
    if (!t.isImportDeclaration(statement) || statement.importKind === 'type' || statement.source.value !== module) continue
    for (const specifier of statement.specifiers) {
      if (t.isImportSpecifier(specifier) && specifier.importKind !== 'type' && t.isIdentifier(specifier.imported, { name: imported })) {
        names.add(specifier.local.name)
      }
    }
  }
  return names
}

function measurementProblems(coverage: ReadonlyMap<string, t.Node>, test: ReadonlyMap<string, t.Node>): string[] {
  const problems: string[] = []
  for (const key of ['enabled', 'cleanOnRerun']) {
    const value = coverage.get(key)
    if (value !== undefined && !t.isBooleanLiteral(value, { value: true })) {
      problems.push(`coverage.${key} must be absent or true`)
    }
  }
  for (const key of ['exclude', 'ignoreClassMethods']) {
    const value = coverage.get(key)
    if (value !== undefined && (!t.isArrayExpression(value) || value.elements.length !== 0)) {
      problems.push(`coverage.${key} must be absent or an empty literal array`)
    }
  }
  for (const setting of [{ label: 'coverage.changed', value: coverage.get('changed') }, { label: 'test.changed', value: test.get('changed') }]) {
    if (setting.value !== undefined && !t.isBooleanLiteral(setting.value, { value: false })) {
      problems.push(`${setting.label} must be absent or false`)
    }
  }
  if (!t.isBooleanLiteral(coverage.get('autoAttachSubprocess'), { value: true })) {
    problems.push('coverage.autoAttachSubprocess must be true')
  }
  return problems
}

/**
 * Reject unreadable configuration, excluded sources and weakened thresholds.
 * @param source - Complete Vitest configuration source.
 * @returns Policy violations; invalid or dynamic object structure throws.
 */
export function coveragePolicyProblems(source: string): string[] {
  const { program } = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  const exported = program.body.find(statement => t.isExportDefaultDeclaration(statement))
  if (!t.isExportDefaultDeclaration(exported)) throw new Error('vitest.config.ts requires a default export')
  const expression = exported.declaration
  if (t.isCallExpression(expression)
    && (!t.isIdentifier(expression.callee) || !valueImports(program, 'vitest/config', 'defineConfig').has(expression.callee.name)
      || expression.arguments.length !== 1)) {
    throw new Error('Vitest configuration requires a defineConfig value import from vitest/config')
  }
  const config = t.isCallExpression(expression) ? expression.arguments[0] : expression
  const root = objectProperties(config, 'Vitest configuration')
  const test = objectProperties(root.get('test'), 'test')
  const coverage = objectProperties(test.get('coverage'), 'coverage')
  const problems = measurementProblems(coverage, test)
  if (!sourceInclude(coverage.get('include'), valueImports(program, './scripts/coverage-debt.ts', 'COVERAGE_SOURCE_GLOB'))) {
    problems.push(`coverage.include must contain exactly ${COVERAGE_SOURCE_GLOB}`)
  }
  const thresholds = objectProperties(coverage.get('thresholds'), 'coverage.thresholds')
  if (!t.isBooleanLiteral(thresholds.get('perFile'), { value: true })) {
    problems.push('coverage.thresholds.perFile must be true')
  }
  for (const metric of ['statements', 'branches', 'functions', 'lines']) {
    if (!t.isNumericLiteral(thresholds.get(metric), { value: 100 })) {
      problems.push(`coverage.thresholds.${metric} must be 100`)
    }
  }
  for (const key of thresholds.keys()) {
    if (!['perFile', 'statements', 'branches', 'functions', 'lines'].includes(key)) {
      problems.push(`coverage.thresholds.${key} is not an approved threshold property`)
    }
  }
  if (!t.isStringLiteral(coverage.get('provider'), { value: 'v8' })) problems.push('coverage.provider must be v8')
  if (!t.isBooleanLiteral(coverage.get('reportOnFailure'), { value: true })) {
    problems.push('coverage.reportOnFailure must be true')
  }
  return problems
}

/**
 * Read the live Vitest configuration.
 * @param root - Repository root.
 * @returns The complete configuration source.
 */
export function vitestConfigSource(root: string = ROOT): string {
  return readFileSync(resolve(root, 'vitest.config.ts'), 'utf8')
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) {
  const problems = coveragePolicyProblems(vitestConfigSource())
  const files = coverageSourceFiles()
  if (problems.length > 0) {
    for (const problem of problems) process.stderr.write(`${problem}\n`)
    process.exitCode = 1
  } else {
    process.stdout.write(`coverage-debt: ${files.length} source file(s), no exclusions, per-file thresholds 100%\n`)
  }
}
