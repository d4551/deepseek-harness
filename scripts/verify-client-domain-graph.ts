/**
 * Enforce intra-package domain layering inside `packages/client/*\/src/client/`.
 * verify-module-graph covers package-level edges; this gate covers the
 * directory level: domain directories may import `contract/` and never each
 * other, and only the assembly point (`apply.ts` / `index.ts`) may import
 * across domains.
 *
 * Layer model (lower may not import higher):
 *   0  contract/            shared contract API (types + slot declarations)
 *   1  <domain>/ + service  domain implementations (skeleton/, chat/, ...)
 *   2  apply.ts, index.ts   assembly point and re-export shell
 *
 * Run directly:
 *   bun x tsx scripts/verify-client-domain-graph.ts
 */

import { globSync, readFileSync } from 'node:fs'
import { join, posix, resolve, sep } from 'node:path'
import { parse, type ParserPlugin } from '@babel/parser'
import traverse from '@babel/traverse'
import * as t from '@babel/types'

const root = resolve(import.meta.dirname, '..')
const CLIENT_DIR = join(root, 'packages/client')

/** Directory names treated as the shared contract layer (importable by all). */
const CONTRACT_DIRS = new Set(['contract'])
/** Top-level client files allowed to import across domains (assembly layer). */
const ASSEMBLY_FILES = new Set(['apply.ts', 'index.ts', 'index.tsx'])

interface Violation { file: string; imported: string; reason: string }

/** Recursively list .ts/.tsx files under dir (relative paths). */
function listSources(dir: string): string[] {
  return globSync('**/*.{ts,tsx}', { cwd: dir })
    .map(rel => rel.split(sep).join('/'))
    .sort()
}

/** First path segment of a client-relative file, or '' for top-level files. */
function domainOf(rel: string): string {
  const ix = rel.indexOf('/')
  return ix === -1 ? '' : rel.slice(0, ix)
}

/**
 * Resolve one relative import to a client-directory-relative path.
 * @param file - Importing file relative to `src/client`.
 * @param specifier - Relative module specifier from that file.
 * @returns Normalized path, preserving leading `..` segments outside `src/client`.
 */
export function resolveClientImport(file: string, specifier: string): string {
  return posix.normalize(posix.join(posix.dirname(file), specifier))
}

/**
 * Check complete TypeScript or TSX source against the client domain layers.
 * @param file - Source path relative to the package's client directory.
 * @param source - Complete source text; invalid syntax throws.
 * @returns Disallowed relative module references, including dynamic and type imports.
 */
export function clientDomainViolations(file: string, source: string): Violation[] {
  const violations: Violation[] = []
  const fromDomain = domainOf(file)
  const isAssembly = fromDomain === '' && ASSEMBLY_FILES.has(file)
  const plugins: ParserPlugin[] = ['typescript', 'decorators']
  if (file.endsWith('.tsx')) plugins.push('jsx')
  const ast = parse(source, { sourceFilename: file, sourceType: 'unambiguous', plugins })
  function record(node: t.Node | undefined): void {
    const spec = t.isStringLiteral(node) ? node.value
      : t.isTemplateLiteral(node) && node.expressions.length === 0 ? node.quasis[0]?.value.cooked
        : undefined
    if (isAssembly || spec === undefined || spec === null || !spec.startsWith('.')) return
    const target = resolveClientImport(file, spec)
    if (target === '..' || target.startsWith('../')) return
    const toDomain = domainOf(target)
    if (toDomain === '' || CONTRACT_DIRS.has(toDomain) || fromDomain === toDomain) return
    violations.push({
      file,
      imported: spec,
      reason: fromDomain === ''
        ? `top-level non-assembly file imports domain "${toDomain}" (only apply/index may assemble)`
        : `domain "${fromDomain}" imports sibling domain "${toDomain}" (route shared API through contract/)`,
    })
  }
  function call(node: t.CallExpression | t.OptionalCallExpression): void {
    if (t.isIdentifier(node.callee, { name: 'require' })
      || ((t.isMemberExpression(node.callee) || t.isOptionalMemberExpression(node.callee))
        && t.isIdentifier(node.callee.object, { name: 'require' }))) {
      record(node.arguments[0])
    }
  }
  traverse(ast, {
    ImportDeclaration({ node }) { record(node.source) },
    ExportNamedDeclaration({ node }) { if (node.source !== null) record(node.source) },
    ExportAllDeclaration({ node }) { record(node.source) },
    ImportExpression({ node }) { record(node.source) },
    TSImportType({ node }) { record(node.source) },
    TSImportEqualsDeclaration({ node }) {
      if (t.isTSExternalModuleReference(node.moduleReference)) record(node.moduleReference.expression)
    },
    CallExpression({ node }) { call(node) },
    OptionalCallExpression({ node }) { call(node) },
  })
  return violations
}

function main(): void {
  const violations: Violation[] = []
  for (const clientPath of globSync('*/src/client', { cwd: CLIENT_DIR }).sort()) {
    const clientDir = join(CLIENT_DIR, clientPath)
    for (const file of listSources(clientDir)) {
      const source = readFileSync(join(clientDir, file), 'utf8')
      for (const violation of clientDomainViolations(file, source)) {
        violations.push({ ...violation, file: `${clientPath}/${file}` })
      }
    }
  }

  if (violations.length > 0) {
    console.error(`verify-client-domain-graph: ${violations.length} violation(s):`)
    for (const v of violations) console.error(`  ${v.file} -> ${v.imported}\n    ${v.reason}`)
    process.exitCode = 1
    return
  }
  console.log('verify-client-domain-graph: client domain layering clean.')
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
