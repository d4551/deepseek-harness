/**
 * The testing policy says every client UI package that ships TSX is held to
 * axe-core. A prose list of audited packages went stale; this asserts the
 * import exists in that package's own tests so a new ui-* surface cannot
 * ship without an audit.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'

const clientRoot = join(import.meta.dirname, '../packages/client')
const A11Y_IMPORT = /from\s+['"]@deepseek-ai\/dsh-client-a11y['"]/
const FLOOR_ARG = /accessibilityFailures\s*\([^;]{0,800}?,\s*(?:100|MINIMUM_ACCESSIBILITY_SCORE|CLIENT_A11Y_FLOOR)\s*,?\s*\)/
const LOWERED_CALL = /accessibilityFailures\s*\([^;]{0,800}?,\s*(?:0|99)\s*,?\s*\)/
const LOWERED_CONST = /(?:MINIMUM_ACCESSIBILITY_SCORE|CLIENT_A11Y_FLOOR)\s*=\s*(?!100\b)\d+/
const FLOOR_EXPECT = /expect\s*\(\s*accessibilityFailures\s*\([^;]{0,800}?\)\s*\)\s*\.to(?:Be|Equal)\(\s*['"]{2}\s*\)/

function filesUnder(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...filesUnder(path))
    else out.push(path)
  }
  return out
}

function uiPackagesWithTsx(): string[] {
  return readdirSync(clientRoot).filter((name) => {
    if (!name.startsWith('ui-')) return false
    const src = join(clientRoot, name, 'src')
    if (!existsSync(src)) return false
    return filesUnder(src).some(path => path.endsWith('.tsx'))
  }).sort()
}

/**
 * Drop block and line comments so a commented-out floor call cannot count.
 * @param source - spec text.
 * @returns comment-free text.
 */
function stripSpecComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"])\/\/[^\n]*/g, '$1')
}

function namedImports(inner: string): string[] {
  return inner.split(',').map(part => part.trim()).filter(part => part !== '' && !part.startsWith('type ')).map((part) => {
    const renamed = part.split(/\s+as\s+/)
    return (renamed[1] ?? renamed[0] ?? '').trim()
  }).filter(name => name !== '')
}

function srcBindings(source: string, packageName: string): { names: string[]; namespaces: string[] } {
  const names: string[] = []
  const namespaces: string[] = []
  const fromSrc = /import\s+(?!type\b)(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+['"](?:\.\.\/)+src[^'"]*['"]/g
  const fromPkg = new RegExp(
    String.raw`import\s+(?!type\b)(?:(\w+)|\{([^}]+)\}|\*\s+as\s+(\w+))\s+from\s+['"]@deepseek-ai/dsh-${packageName}(?:/[^'"]*)?['"]`,
    'g',
  )
  for (const re of [fromSrc, fromPkg]) {
    re.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(source)) !== null) {
      if (match[1] !== undefined) names.push(match[1])
      if (match[2] !== undefined) names.push(...namedImports(match[2]))
      if (match[3] !== undefined) namespaces.push(match[3])
    }
  }
  return { names, namespaces }
}

function withoutImportLines(source: string): string {
  return source.replace(/^[ \t]*import\s[\s\S]*?from\s+['"][^'"]+['"];?/gm, '')
}

function matchingParen(text: string, openIndex: number): number {
  let depth = 0
  let quote: string | undefined
  for (let index = openIndex; index < text.length; index += 1) {
    const character = text.charAt(index)
    if (quote !== undefined) {
      if (character === '\\') {
        index += 1
        continue
      }
      if (character === quote) quote = undefined
      continue
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character
      continue
    }
    if (character === '(') depth += 1
    else if (character === ')') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function callArguments(source: string, callee: string): string[] {
  const args: string[] = []
  const needle = `${callee}(`
  let from = 0
  while (from < source.length) {
    const start = source.indexOf(needle, from)
    if (start < 0) break
    if (start > 0 && /\w/.test(source.charAt(start - 1))) {
      from = start + needle.length
      continue
    }
    const open = start + needle.length - 1
    const close = matchingParen(source, open)
    if (close < 0) break
    args.push(source.slice(open + 1, close))
    from = close + 1
  }
  return args
}

const SKIP_IDENTS = new Set([
  'const', 'let', 'var', 'null', 'undefined', 'true', 'false', 'return', 'await',
  'new', 'void', 'typeof', 'function', 'async', 'createElement', 'Fragment',
  'render', 'cleanup', 'main', 'div', 'span', 'p',
])

function assignedFromComponent(source: string, ident: string, component: string): boolean {
  const assigned = new RegExp(
    `(?:const|let|var)\\s+${ident}\\s*=\\s*(?:createElement\\(\\s*${component}\\b|<${component}[\\s/>])`,
  )
  return assigned.test(source)
}

function renderArgUses(arg: string, name: string, file: string): boolean {
  if (new RegExp(`(?:<${name}[\\s/>]|createElement\\(\\s*${name}\\b)`).test(arg)) return true
  const idents = [...arg.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map(match => match[1] ?? '')
  for (const ident of idents) {
    if (ident === name) return true
    if (SKIP_IDENTS.has(ident)) continue
    if (assignedFromComponent(file, ident, name)) return true
  }
  return false
}

function isDummyRenderArg(arg: string): boolean {
  const hasComponent = /<[A-Z][A-Za-z0-9]*/.test(arg) || /createElement\(\s*[A-Z]/.test(arg)
  const hasFactoryCall = /\b[a-z][\w$]*\s*\(/.test(arg)
  return !hasComponent && !hasFactoryCall
}

function componentJsxOrCreateElement(source: string, name: string): boolean {
  const body = withoutImportLines(source)
  return new RegExp(`<${name}[\\s/>]`).test(body) || new RegExp(`createElement\\(\\s*${name}\\b`).test(body)
}

function localHelperSources(specFile: string, source: string): { file: string; content: string }[] {
  const helpers: { file: string; content: string }[] = []
  const seen = new Set<string>()
  const fromLocal = /from\s+['"](\.\/[^'"]+)['"]/g
  let match: RegExpExecArray | null
  while ((match = fromLocal.exec(source)) !== null) {
    const spec = match[1]
    if (spec === undefined) continue
    const abs = join(dirname(specFile), spec)
    if (seen.has(abs) || !existsSync(abs)) continue
    seen.add(abs)
    helpers.push({ file: abs, content: readFileSync(abs, 'utf8') })
  }
  return helpers
}

/**
 * Whether a spec holds the axe floor: it must import the harness, run
 * `auditSurface`, and `expect(accessibilityFailures(...)).toBe('')` at 100.
 * Score-only, silent, commented-out, or lowered-floor audits do not count.
 * @param source - spec text.
 * @returns true when the spec can fail on a silent or violating surface at 100.
 */
export function specHoldsAxeFloor(source: string): boolean {
  const text = stripSpecComments(source)
  if (!A11Y_IMPORT.test(text)) return false
  if (!text.includes('auditSurface(')) return false
  if (LOWERED_CALL.test(text) || LOWERED_CONST.test(text)) return false
  if (!FLOOR_ARG.test(text)) return false
  return FLOOR_EXPECT.test(text)
}

/**
 * Whether a spec that holds the axe floor also audits the package under test.
 *
 * A dummy landmark (`<main><p>Probe</p></main>`) can satisfy
 * {@link specHoldsAxeFloor} without rendering a package export. Coverage
 * requires a `../src` binding inside a `render(...)` argument (or a variable
 * that `render` receives), including `render` calls in local `./` helpers.
 * Stray `createElement` / JSX / member access next to an audit does not count.
 * @param source - spec text.
 * @param packageName - `ui-*` directory name.
 * @param helpers - local test helper modules the spec imports.
 * @returns true when the spec renders that package's source and holds the floor.
 */
export function specAuditsPackageSource(
  source: string,
  packageName: string,
  helpers: readonly { file: string; content: string }[] = [],
): boolean {
  if (!specHoldsAxeFloor(source)) return false
  const texts = [source, ...helpers.map(helper => helper.content)].map(stripSpecComments)
  const bindings = [...new Set(texts.flatMap((text) => {
    const { names, namespaces } = srcBindings(text, packageName)
    const fromNs = namespaces.flatMap(ns => namesFromNamespaceDestructure(text, ns))
    return [...names, ...namespaces, ...fromNs]
  }))]
  if (bindings.length === 0) return false
  const factory = (text: string, name: string): boolean =>
    new RegExp(`\\b${name}\\s*\\(`).test(withoutImportLines(text))
  for (const text of texts) {
    const renderArgs = callArguments(text, 'render')
    if (bindings.some(name => renderArgs.some(arg => renderArgUses(arg, name, text)))) return true
    const liveRender = renderArgs.some(arg => !isDummyRenderArg(arg))
    if (!liveRender) continue
    if (bindings.some(name => componentJsxOrCreateElement(text, name))) return true
    if (bindings.some(name => factory(text, name))) return true
  }
  return false
}

function namesFromNamespaceDestructure(source: string, namespace: string): string[] {
  const match = new RegExp(`\\{([^}]+)\\}\\s*=\\s*${namespace}\\b`).exec(source)
  if (match?.[1] === undefined) return []
  return namedImports(match[1])
}

function packageAuditsAxe(name: string): boolean {
  const tests = join(clientRoot, name, 'tests')
  if (!existsSync(tests)) return false
  return filesUnder(tests).some((path) => {
    if (!path.includes('.spec.')) return false
    const source = readFileSync(path, 'utf8')
    return specAuditsPackageSource(source, name, localHelperSources(path, source))
  })
}

/**
 * ui-* packages that ship TSX but have no spec that audits their own source.
 * @returns missing package directory names, sorted.
 */
export function uiPackagesMissingAxeCoverage(): string[] {
  return uiPackagesWithTsx().filter(name => !packageAuditsAxe(name))
}

/** Absolute `packages/client` directory the coverage scan reads. */
export const CLIENT_PACKAGES_ROOT = clientRoot
