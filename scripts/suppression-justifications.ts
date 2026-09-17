/** Reject diagnostic directives and catch clauses/handlers throughout authored source and tests. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'
import traverse, { type NodePath } from '@babel/traverse'
import { gitWorktreeFiles } from './git-worktree-files.ts'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx', 'mts', 'cts', 'mjs', 'cjs']
const SOURCE_GROUPS = [
  /^packages\/[^/]+\/[^/]+\/src\//,
  /^packages\/[^/]+\/[^/]+\/tests\//,
  /^apps\/[^/]+\/src\//,
  /^apps\/[^/]+\/tests\//,
  /^scripts\//,
  /^snapshots\//,
  /^vendor\//,
  /^native\//,
  /^website\//,
  /^\.github\//,
  /^[^/]+$/,
]
const LINT_DIRECTIVE =
  /^(?:(?:oxlint|eslint|tslint)-disable(?:-next-line|-line)?\b|biome-ignore(?:-all|-start)?\b|(?:prettier|dprint)-ignore\b)/

/** One prohibited directive, catch clause or unreadable source construct. */
export interface SuppressionViolation {
  file: string
  line: number
  kind: 'lint-directive' | 'typescript-directive' | 'coverage-directive' | 'mutation-directive' | 'catch-clause' | 'catch-handler' | 'parse-error'
  text: string
}

/** Complete source input; paths are normalized before reporting. */
export interface SuppressionSource {
  file: string
  content: string
}

function directiveKind(text: string): SuppressionViolation['kind'] | undefined {
  const directive = text.trimStart().replace(/^\*\s*/, '')
  if (LINT_DIRECTIVE.test(directive)) {
    return 'lint-directive'
  }
  if (/^(?:eslint|oxlint)\s/.test(directive) && /:\s*(?:0\b|['"]off['"]|\[\s*(?:0\b|['"]off['"]))/i.test(directive)) {
    return 'lint-directive'
  }
  if (/^@ts-(?:ignore|expect-error|nocheck)\b/.test(directive)) return 'typescript-directive'
  if (/^(?:istanbul|c8|v8|node:coverage)\s+(?:ignore|disable)\b/.test(directive)) return 'coverage-directive'
  if (/^Stryker\s+disable(?:\s|$)/.test(directive)) return 'mutation-directive'
  return undefined
}

function expressionValue(path: NodePath): NodePath {
  let value = path
  while (value.isTSAsExpression() || value.isTSTypeAssertion() || value.isTSNonNullExpression()
    || value.isTSSatisfiesExpression() || value.isParenthesizedExpression()) {
    value = value.get('expression')
  }
  return value
}

interface StringAnalysis {
  readonly values: Map<NodePath, string | undefined>
  /** Expanded strings cannot exceed the containing source's code-unit length. */
  readonly maxLength: number
}

function propertyName(
  path: NodePath, computed: boolean, seen: ReadonlySet<NodePath>, analysis: StringAnalysis,
): string | undefined {
  return !computed && path.isIdentifier() ? path.node.name : literalString(path, seen, analysis)
}

/** Select a binding from inline data without reading getters, spreads or shared objects. */
function destructuredValue(
  pattern: NodePath, input: NodePath, name: string, seen: ReadonlySet<NodePath>, analysis: StringAnalysis,
): NodePath | undefined {
  const value = expressionValue(input)
  if (pattern.isIdentifier()) return pattern.node.name === name ? value : undefined
  if (pattern.isObjectPattern() && value.isObjectExpression()) {
    const entries = new Map<string, NodePath>()
    for (const entry of value.get('properties')) {
      if (!entry.isObjectProperty()) return undefined
      const key = propertyName(entry.get('key'), entry.node.computed, seen, analysis)
      if (key === undefined || (key === '__proto__' && !entry.node.computed)) return undefined
      entries.set(key, entry.get('value'))
    }
    for (const entry of pattern.get('properties')) {
      if (!entry.isObjectProperty()) continue
      const key = propertyName(entry.get('key'), entry.node.computed, seen, analysis)
      const selected = key === undefined ? undefined : entries.get(key)
      if (selected === undefined) continue
      const result = destructuredValue(entry.get('value'), selected, name, seen, analysis)
      if (result !== undefined) return result
    }
  }
  if (pattern.isArrayPattern() && value.isArrayExpression()) {
    const elements = value.get('elements')
    if (elements.some(element => element.isSpreadElement())) return undefined
    for (const [index, entry] of pattern.get('elements').entries()) {
      const selected = elements[index]
      if (entry.node === null || selected === undefined || selected.node === null) continue
      const result = destructuredValue(entry, selected, name, seen, analysis)
      if (result !== undefined) return result
    }
  }
  return undefined
}

/** Prove strings from syntax and constant bindings; calls and runtime coercions remain unproven. */
function literalString(input: NodePath, ancestors: ReadonlySet<NodePath>, analysis: StringAnalysis): string | undefined {
  const path = expressionValue(input)
  if (ancestors.has(path)) return undefined
  const seen = new Set(ancestors).add(path)
  if (path.isStringLiteral()) return path.node.value
  if (path.isBinaryExpression({ operator: '+' })) {
    const left = literalString(path.get('left'), seen, analysis)
    const right = literalString(path.get('right'), seen, analysis)
    if (left === undefined || right === undefined || left.length + right.length > analysis.maxLength) return undefined
    return left + right
  }
  if (path.isTemplateLiteral()) {
    let result = ''
    const expressions = path.get('expressions')
    for (const [index, quasi] of path.node.quasis.entries()) {
      if (typeof quasi.value.cooked !== 'string') return undefined
      if (result.length + quasi.value.cooked.length > analysis.maxLength) return undefined
      result += quasi.value.cooked
      const expression = expressions[index]
      if (expression !== undefined) {
        const part = literalString(expression, seen, analysis)
        if (part === undefined || result.length + part.length > analysis.maxLength) return undefined
        result += part
      }
    }
    return result
  }
  if (!path.isReferencedIdentifier()) return undefined
  const binding = path.scope.getBinding(path.node.name)
  if (binding === undefined || binding.kind !== 'const' || !binding.constant
    || !binding.path.isVariableDeclarator()) return undefined
  const start = path.node.start
  const end = binding.path.node.end
  if (start === null || start === undefined || end === null || end === undefined || start < end) return undefined
  const init = binding.path.get('init')
  if (init.node === null) return undefined
  const selected = destructuredValue(binding.path.get('id'), init, path.node.name, seen, analysis)
  if (selected === undefined) return undefined
  if (analysis.values.has(selected)) return analysis.values.get(selected)
  const result = literalString(selected, seen, analysis)
  analysis.values.set(selected, result)
  return result
}

function handlerProperty(path: NodePath, computed: boolean, validSyntax: boolean, sourceLength: number): boolean {
  if (!computed && path.isIdentifier()) return path.node.name === 'catch'
  if (path.isStringLiteral()) return path.node.value === 'catch'
  if (path.isTemplateLiteral() && path.node.expressions.length === 0) {
    return path.node.quasis[0]?.value.cooked === 'catch'
  }
  if (!computed || !validSyntax) return false
  return literalString(path, new Set(), { values: new Map(), maxLength: sourceLength }) === 'catch'
}

/**
 * Inspect actual comments and catch clauses/handlers, including directives carrying explanations.
 * Computed names require a bounded syntax proof; unsupported computation remains unproven.
 * @param sources - Complete authored source files.
 * @returns Violations sorted by path and line. Empty inputs and unrecoverable syntax errors throw.
 */
export function scanSuppressions(sources: readonly SuppressionSource[]): SuppressionViolation[] {
  if (sources.length === 0) throw new Error('suppression scan: source corpus must be nonempty')
  const violations: SuppressionViolation[] = []
  for (const source of sources) {
    const file = source.file.replaceAll('\\', '/')
    const plugins: ParserPlugin[] = ['decorators', 'decoratorAutoAccessors']
    if (/\.[cm]?tsx?$/.test(file)) plugins.push(['typescript', { dts: /\.d\.[cm]?ts$/.test(file) }])
    if (/\.[jt]sx$/.test(file)) plugins.push('jsx')
    const ast = parse(source.content, { sourceFilename: file, sourceType: 'unambiguous', plugins, errorRecovery: true })
    for (const error of ast.errors) {
      violations.push({ file, line: error.loc.line, kind: 'parse-error', text: error.message })
    }
    for (const comment of ast.comments ?? []) {
      if (comment.loc === undefined) throw new Error(`${file}: comment location is missing`)
      for (const [offset, line] of comment.value.split('\n').entries()) {
        const kind = directiveKind(line)
        if (kind !== undefined) violations.push({ file, line: comment.loc.start.line + offset, kind, text: line.trim() })
      }
    }
    const recordCatchHandler = (path: NodePath, computed: boolean): void => {
      if (!handlerProperty(path, computed, ast.errors.length === 0, source.content.length)) return
      const property = path.node
      if (property.loc === undefined || property.loc === null || property.start === null || property.start === undefined) {
        throw new Error(`${file}: catch-handler location is missing`)
      }
      const end = source.content.indexOf('\n', property.start)
      const text = source.content.slice(property.start, end < 0 ? source.content.length : end).trim()
      violations.push({ file, line: property.loc.start.line, kind: 'catch-handler', text })
    }
    traverse(ast, {
      noScope: ast.errors.length > 0,
      MemberExpression(path) { recordCatchHandler(path.get('property'), path.node.computed) },
      OptionalMemberExpression(path) { recordCatchHandler(path.get('property'), path.node.computed) },
      ObjectProperty(path) {
        if (path.parentPath.isObjectPattern()) recordCatchHandler(path.get('key'), path.node.computed)
      },
      CatchClause({ node }) {
        if (node.loc === undefined || node.loc === null || node.start === null || node.start === undefined) {
          throw new Error(`${file}: catch location is missing`)
        }
        const end = source.content.indexOf('\n', node.start)
        const text = source.content.slice(node.start, end < 0 ? source.content.length : end).trim()
        violations.push({ file, line: node.loc.start.line, kind: 'catch-clause', text })
      },
    })
  }
  return violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind))
}

/**
 * Load tracked and untracked repository JavaScript and TypeScript, including configuration and vendored source.
 * @param root - Repository root.
 * @returns Full corpus; an absent source group fails rather than narrowing the scan.
 */
export function loadSuppressionCorpus(root: string = ROOT): SuppressionSource[] {
  const { files } = gitWorktreeFiles(root, SOURCE_EXTENSIONS.map(extension => `*.${extension}`))
  const sources = files.map(file => ({ file, content: readFileSync(resolve(root, file), 'utf8') }))
  for (const group of SOURCE_GROUPS) {
    if (!sources.some(source => group.test(source.file))) throw new Error(`suppression scan: no authored source found in ${group}`)
  }
  return sources.sort((a, b) => a.file.localeCompare(b.file))
}
