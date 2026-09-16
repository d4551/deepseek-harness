/** Reject diagnostic directives and catch clauses/handlers throughout authored source and tests. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'
import traverse from '@babel/traverse'
import type { MemberExpression, OptionalMemberExpression } from '@babel/types'
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

/**
 * Inspect actual comments and catch clauses/handlers, including directives carrying explanations.
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
    const recordCatchHandler = (node: MemberExpression | OptionalMemberExpression): void => {
      const property = node.property
      const name = node.computed
        ? property.type === 'StringLiteral'
          ? property.value
          : property.type === 'TemplateLiteral' && property.expressions.length === 0
            ? property.quasis[0]?.value.cooked
            : undefined
        : property.type === 'Identifier' ? property.name : undefined
      if (name !== 'catch') return
      if (property.loc === undefined || property.loc === null || property.start === null || property.start === undefined) {
        throw new Error(`${file}: catch-handler location is missing`)
      }
      const end = source.content.indexOf('\n', property.start)
      const text = source.content.slice(property.start, end < 0 ? source.content.length : end).trim()
      violations.push({ file, line: property.loc.start.line, kind: 'catch-handler', text })
    }
    traverse(ast, {
      noScope: true,
      MemberExpression({ node }) { recordCatchHandler(node) },
      OptionalMemberExpression({ node }) { recordCatchHandler(node) },
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
