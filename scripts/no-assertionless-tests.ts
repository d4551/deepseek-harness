/**
 * Test cases that pass whether or not the code under test works.
 *
 * A case registered with `it` or `test` earns its place by asserting
 * something. Three shapes do not, and each passes on a green tree for a reason
 * unrelated to the behavior its title names:
 *
 * - **`empty-body`** — the case body holds no statements, so the runner records
 *   a pass for a case that ran nothing.
 * - **`no-assertion`** — the body runs code and never reaches an assertion, so
 *   the only failure it can report is a thrown exception. A title that promises
 *   an observable consequence ("ignores X", "keeps Y") is not checked at all.
 * - **`callback-only-assertion`** — every assertion sits inside a listener
 *   callback (`.on(…)`, `.subscribe(…)`) that nothing in the case forces to
 *   run, so the case passes when the event never fires.
 *
 * Resolution is syntactic and call-target aware: a case delegating to a helper
 * — declared in the same module or imported over a relative path — is asserted
 * when that helper transitively asserts, which is how the `type-model-cases-*`
 * suites are written. Three levels of delegation are followed. A regex over
 * the same corpus cannot tell `it.each(rows)(…)` from `test.ctx.on(…)`, nor a
 * case body from the helper that holds its assertions.
 * @module scripts/no-assertionless-tests
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { dirname as posixDirname, normalize as posixNormalize } from 'node:path/posix'
import type { ArrowFunction, CallExpression, FunctionExpression, Node, SourceFile } from 'typescript/unstable/ast'
import {
  isArrowFunction,
  isBlock,
  isCallExpression,
  isClassDeclaration,
  isFunctionDeclaration,
  isFunctionExpression,
  isIdentifier,
  isImportDeclaration,
  isNamedImports,
  isNamespaceImport,
  isNoSubstitutionTemplateLiteral,
  isPropertyAccessExpression,
  isStringLiteral,
  isVariableStatement,
} from 'typescript/unstable/ast/is'
import { createSourceFile, parsePaths } from './ts7-session.ts'
import { isEmittedOrVendored, uniqueRepoFiles } from './repo-files.ts'

/** One test case that can pass without exercising the behavior it names. */
export interface AssertionlessTestFinding {
  /** Repository-relative path of the spec file. */
  readonly file: string
  /** 1-based line of the runner call. */
  readonly line: number
  /** Title of the case, as authored. */
  readonly test: string
  /** Which no-op form fired. */
  readonly kind: 'empty-body' | 'no-assertion' | 'callback-only-assertion'
  /** What the case does instead of asserting. */
  readonly detail: string
}

/** One module the scanner can read: repository-relative path plus source text. */
export interface TestModuleSource {
  /** Repository-relative path, used in findings and to resolve relative imports. */
  readonly file: string
  /** Raw TypeScript source. */
  readonly source: string
}

/**
 * Resolve one relative import to the module it names.
 *
 * Bare specifiers resolve to `undefined`: a helper behind a package name is
 * outside the corpus this gate reads, and a case that delegates to one is
 * reported rather than assumed to assert.
 */
export type ModuleResolver = (fromFile: string, specifier: string) => TestModuleSource | undefined

const ROOT = resolve(import.meta.dirname, '..')

/** Runner globals that register a case. */
const RUNNER_NAMES = new Set(['it', 'test'])

/**
 * Vitest modifiers that keep a chained call a runner call. Only these names
 * may appear between the runner and its invocation, which is what separates
 * `it.skip.each(rows)(…)` from an unrelated chain such as `test.ctx.on(…)`.
 */
const RUNNER_MODIFIERS = new Set([
  'concurrent',
  'each',
  'extend',
  'fails',
  'for',
  'only',
  'runIf',
  'sequential',
  'skip',
  'skipIf',
  'todo',
])

/** Callee roots that assert. `expect.soft(…)` and `assert.equal(…)` root here too. */
const ASSERTION_ROOTS = new Set(['assert', 'assertType', 'expect', 'expectTypeOf'])

/**
 * Testing Library queries that raise when the match is absent, so reaching one
 * decides the case exactly as an assertion does: `screen.findByText(label)`
 * rejects when the label never appears. The `queryBy*` family is excluded on
 * purpose — it answers `null` and decides nothing on its own.
 */
const THROWING_QUERY = /^(?:get|find)(?:All)?By[A-Z]/u

/**
 * Subscription methods whose callback argument runs only if the event fires.
 * An assertion reachable only through one of these is not guaranteed to run.
 */
const LISTENER_METHODS = new Set([
  'addEventListener',
  'addListener',
  'on',
  'once',
  'prependListener',
  'prependOnceListener',
  'subscribe',
])

/** Delegation levels followed from a case body before a helper counts as silent. */
const MAX_DELEGATION_DEPTH = 3

/** A parsed module plus the path its relative imports resolve against. */
interface ParsedModule {
  readonly file: string
  readonly source: SourceFile
}

/** What one function body does about asserting, before helpers are resolved. */
interface BodyScan {
  /** An assertion the case reaches directly. */
  readonly asserts: boolean
  /** An assertion reachable only from inside a listener callback. */
  readonly listenerAsserts: boolean
  /** Names of called functions that may hold the assertions. */
  readonly calls: readonly CallTarget[]
  /** The body is a block with no statements. */
  readonly empty: boolean
}

/** A resolvable call target: a plain name, or a name on a namespace import. */
interface CallTarget {
  readonly namespace?: string
  readonly name: string
}

/** 1-based line of a node's start. */
function lineOf(node: Node, source: SourceFile): number {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
}

/**
 * The identifier a callee chain bottoms out at: `expect` for
 * `expect.soft(x).toBe(y)`, `manager` for `manager.handleSessionStatus(…)`.
 */
function leftmostIdentifier(node: Node): string | undefined {
  let current = node
  for (;;) {
    if (isIdentifier(current)) return current.text
    if (isCallExpression(current) || isPropertyAccessExpression(current)) {
      current = current.expression
      continue
    }
    if ('expression' in current) {
      const inner: unknown = Reflect.get(current, 'expression')
      if (typeof inner === 'object' && inner !== null && 'kind' in inner) {
        current = inner as Node
        continue
      }
    }
    return undefined
  }
}

/** The runner name a callee chain names, when every link is a runner modifier. */
function runnerRoot(callee: Node): string | undefined {
  if (isIdentifier(callee)) return callee.text
  if (isPropertyAccessExpression(callee)) {
    return RUNNER_MODIFIERS.has(callee.name.text) ? runnerRoot(callee.expression) : undefined
  }
  // `it.each(rows)(…)` and `it.runIf(flag)(…)`: the chain is invoked twice, and
  // only the modifier call may sit in callee position. A bare `it(…)(…)` is not
  // a runner call.
  if (isCallExpression(callee)) {
    return isPropertyAccessExpression(callee.expression) ? runnerRoot(callee.expression) : undefined
  }
  return undefined
}

/** Modifier names on a runner callee chain, outermost last. */
function runnerModifiers(callee: Node): string[] {
  if (isPropertyAccessExpression(callee)) return [...runnerModifiers(callee.expression), callee.name.text]
  if (isCallExpression(callee)) return runnerModifiers(callee.expression)
  return []
}

/**
 * Names the module binds itself, so a local `const test = await bench(…)` is
 * never read as the runner. Parameters are excluded: a callback parameter
 * named `it` shadows nothing the file registers cases with.
 */
function shadowedRunnerNames(source: SourceFile): Set<string> {
  const shadowed = new Set<string>()
  const bind = (name: Node): void => {
    if (isIdentifier(name) && RUNNER_NAMES.has(name.text)) shadowed.add(name.text)
  }
  const visit = (node: Node): void => {
    if (isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) bind(declaration.name)
    } else if (isFunctionDeclaration(node) || isClassDeclaration(node)) {
      if (node.name !== undefined) bind(node.name)
    } else if (isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier
      const from = isStringLiteral(specifier) ? specifier.text : ''
      if (from !== 'vitest') {
        const clause = node.importClause
        if (clause?.name !== undefined) bind(clause.name)
        const bindings = clause?.namedBindings
        if (bindings !== undefined && isNamedImports(bindings)) {
          for (const element of bindings.elements) bind(element.name)
        }
      }
    }
    node.forEachChild(visit)
  }
  source.forEachChild(visit)
  return shadowed
}

/** The authored title of a case, for the finding text. */
function caseTitle(argument: Node | undefined, source: SourceFile): string {
  if (argument === undefined) return '<untitled>'
  if (isStringLiteral(argument) || isNoSubstitutionTemplateLiteral(argument)) return argument.text
  return argument.getText(source).replace(/\s+/gu, ' ').trim()
}

/** Whether a node declares a function body inline. */
function isInlineFunction(node: Node): node is ArrowFunction | FunctionExpression {
  return isArrowFunction(node) || isFunctionExpression(node)
}

/**
 * The argument holding the case body: the inline function if there is one, and
 * otherwise the reference the case delegates to (`it('name', importedCase)`).
 * Options objects, timeouts, and the title are skipped.
 */
function caseBody(args: readonly Node[]): Node | undefined {
  const inline = args.slice(1).find(isInlineFunction)
  if (inline !== undefined) return inline
  return args.slice(1).find(argument => isIdentifier(argument) || isPropertyAccessExpression(argument))
}

/** The call target a callee names, when the scanner can follow it. */
function callTarget(callee: Node): CallTarget | undefined {
  if (isIdentifier(callee)) return { name: callee.text }
  if (isPropertyAccessExpression(callee) && isIdentifier(callee.expression)) {
    return { namespace: callee.expression.text, name: callee.name.text }
  }
  return undefined
}

/**
 * Walk one function body for assertions and for the calls that might hold
 * them. Assertions inside a listener callback are recorded apart: nothing in
 * the case forces such a callback to run.
 */
function scanBody(body: Node): BodyScan {
  // `it('name', importedCase)` delegates instead of holding a body.
  const reference = isIdentifier(body) || isPropertyAccessExpression(body) ? callTarget(body) : undefined
  if (reference !== undefined) {
    return { asserts: false, listenerAsserts: false, calls: [reference], empty: false }
  }
  let asserts = false
  let listenerAsserts = false
  const calls: CallTarget[] = []
  const visit = (node: Node, inListener: boolean): void => {
    if (isCallExpression(node)) {
      const root = leftmostIdentifier(node.expression)
      const query = isPropertyAccessExpression(node.expression) && THROWING_QUERY.test(node.expression.name.text)
      if ((root !== undefined && ASSERTION_ROOTS.has(root)) || query) {
        if (inListener) listenerAsserts = true
        else asserts = true
      } else {
        const target = callTarget(node.expression)
        if (target !== undefined) calls.push(target)
        const listener = isPropertyAccessExpression(node.expression)
          && LISTENER_METHODS.has(node.expression.name.text)
        if (listener) {
          node.expression.forEachChild((child) => { visit(child, inListener) })
          for (const argument of node.arguments) {
            visit(argument, inListener || isInlineFunction(argument))
          }
          return
        }
      }
    }
    node.forEachChild((child) => { visit(child, inListener) })
  }
  visit(body, false)
  const block = isInlineFunction(body) ? body.body : undefined
  const empty = block !== undefined && isBlock(block) && block.statements.length === 0
  return { asserts, listenerAsserts, calls, empty }
}

/** Resolve a relative specifier to the repository-relative path it names. */
function relativeTarget(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return undefined
  return posixNormalize(`${posixDirname(fromFile)}/${specifier}`)
}

/** Extension spellings one specifier may reach, in resolution order. */
function specifierCandidates(target: string): string[] {
  return [target, target.replace(/\.js$/u, '.ts'), `${target}.ts`, `${target}.tsx`, `${target}/index.ts`]
}

/**
 * Build a resolver over in-memory modules.
 * @param modules - every module the fixture corpus holds.
 * @returns a resolver that follows relative specifiers inside that corpus.
 */
export function fixtureModuleResolver(modules: readonly TestModuleSource[]): ModuleResolver {
  const byPath = new Map(modules.map(module => [module.file, module]))
  return (fromFile, specifier) => {
    const target = relativeTarget(fromFile, specifier)
    if (target === undefined) return undefined
    for (const candidate of specifierCandidates(target)) {
      const found = byPath.get(candidate)
      if (found !== undefined) return found
    }
    return undefined
  }
}

/**
 * Build a resolver over the working tree.
 * @param root - repository root the module paths are relative to.
 * @returns a resolver that reads relative imports from disk.
 */
function diskModuleResolver(root: string): ModuleResolver {
  return (fromFile, specifier) => {
    const target = relativeTarget(fromFile, specifier)
    if (target === undefined) return undefined
    for (const candidate of specifierCandidates(target)) {
      const absolute = resolve(root, candidate)
      if (!existsSync(absolute) || !statSync(absolute).isFile()) continue
      return { file: candidate, source: readFileSync(absolute, 'utf8') }
    }
    return undefined
  }
}

/** Parsed modules shared across one scan, so each helper parses once. */
class ModuleGraph {
  private readonly parsed = new Map<string, ParsedModule>()

  constructor(private readonly resolveModule: ModuleResolver) {}

  /** Record an already-parsed module so a batched audit does not reparse it. */
  seed(module: ParsedModule): void {
    this.parsed.set(module.file, module)
  }

  /** The module a relative specifier names, parsed once per scan. */
  follow(fromFile: string, specifier: string): ParsedModule | undefined {
    const found = this.resolveModule(fromFile, specifier)
    if (found === undefined) return undefined
    const cached = this.parsed.get(found.file)
    if (cached !== undefined) return cached
    const module: ParsedModule = { file: found.file, source: createSourceFile(found.file, found.source) }
    this.parsed.set(found.file, module)
    return module
  }
}

/** The function body a declaration binds to `name`, searched module-wide. */
function localDeclaration(module: ParsedModule, name: string): Node | undefined {
  let found: Node | undefined
  const visit = (node: Node): void => {
    if (found !== undefined) return
    if (isFunctionDeclaration(node) && node.name !== undefined && isIdentifier(node.name) && node.name.text === name) {
      found = node
      return
    }
    if (isVariableStatement(node)) {
      for (const declaration of node.declarationList.declarations) {
        const initializer = declaration.initializer
        if (isIdentifier(declaration.name) && declaration.name.text === name && initializer !== undefined) {
          found = initializer
          return
        }
      }
    }
    node.forEachChild(visit)
  }
  module.source.forEachChild(visit)
  return found
}

/** The module and local name a named import binds, following one hop. */
function importedBinding(
  module: ParsedModule,
  graph: ModuleGraph,
  name: string,
): { readonly module: ParsedModule; readonly name: string } | undefined {
  let found: { readonly module: ParsedModule; readonly name: string } | undefined
  const visit = (node: Node): void => {
    if (found !== undefined || !isImportDeclaration(node)) return
    const specifier = node.moduleSpecifier
    if (!isStringLiteral(specifier)) return
    const bindings = node.importClause?.namedBindings
    if (bindings === undefined) return
    if (isNamespaceImport(bindings) && bindings.name.text === name) {
      const target = graph.follow(module.file, specifier.text)
      if (target !== undefined) found = { module: target, name }
      return
    }
    if (!isNamedImports(bindings)) return
    for (const element of bindings.elements) {
      if (element.name.text !== name) continue
      const target = graph.follow(module.file, specifier.text)
      if (target === undefined) return
      const exported = element.propertyName
      found = { module: target, name: exported !== undefined && isIdentifier(exported) ? exported.text : name }
      return
    }
  }
  module.source.forEachChild(visit)
  return found
}

/**
 * Whether a call target reaches an assertion within the remaining delegation
 * budget. Same-module declarations are searched first; a name the module
 * imports over a relative path continues in the module that owns it.
 */
function targetAsserts(
  module: ParsedModule,
  graph: ModuleGraph,
  target: CallTarget,
  depth: number,
  seen: Set<string>,
): boolean {
  if (depth > MAX_DELEGATION_DEPTH) return false
  const key = `${module.file}#${target.namespace ?? ''}#${target.name}`
  if (seen.has(key)) return false
  seen.add(key)
  if (target.namespace !== undefined) {
    const namespaceModule = importedBinding(module, graph, target.namespace)
    if (namespaceModule === undefined) return false
    return targetAsserts(namespaceModule.module, graph, { name: target.name }, depth, seen)
  }
  const local = localDeclaration(module, target.name)
  if (local !== undefined) return bodyAsserts(module, graph, local, depth, seen)
  const imported = importedBinding(module, graph, target.name)
  if (imported === undefined) return false
  const declaration = localDeclaration(imported.module, imported.name)
  if (declaration === undefined) return false
  return bodyAsserts(imported.module, graph, declaration, depth, seen)
}

/** Whether a body asserts directly or through the helpers it calls. */
function bodyAsserts(
  module: ParsedModule,
  graph: ModuleGraph,
  body: Node,
  depth: number,
  seen: Set<string>,
): boolean {
  const scan = scanBody(body)
  if (scan.asserts || scan.listenerAsserts) return true
  return scan.calls.some(target => targetAsserts(module, graph, target, depth + 1, seen))
}

/** Parameter names a function-like node binds, when it binds simple names. */
function parameterNames(node: Node): string[] {
  if (!('parameters' in node)) return []
  const parameters: unknown = Reflect.get(node, 'parameters')
  if (!Array.isArray(parameters)) return []
  return parameters.flatMap((parameter: unknown) => {
    if (typeof parameter !== 'object' || parameter === null || !('name' in parameter)) return []
    const name: unknown = Reflect.get(parameter, 'name')
    return typeof name === 'object' && name !== null && 'kind' in name && isIdentifier(name as Node)
      ? [(name as Node & { text: string }).text]
      : []
  })
}

/** Whether a body reads any of the given names. */
function referencesAny(body: Node, names: ReadonlySet<string>): boolean {
  if (names.size === 0) return false
  let found = false
  const visit = (node: Node): void => {
    if (found) return
    if (isIdentifier(node) && names.has(node.text)) {
      found = true
      return
    }
    node.forEachChild(visit)
  }
  visit(body)
  return found
}

/** Collect every assertionless case in one parsed spec module. */
function collectAssertionlessTests(module: ParsedModule, graph: ModuleGraph): AssertionlessTestFinding[] {
  const { file, source } = module
  const shadowed = shadowedRunnerNames(source)
  const found: AssertionlessTestFinding[] = []
  const record = (node: CallExpression, injected: ReadonlySet<string>): void => {
    // `it.todo('name')` declares work with no body by design.
    if (runnerModifiers(node.expression).includes('todo')) return
    const args = [...node.arguments]
    if (args.length === 0) return
    const body = caseBody(args)
    // `it('name')` without a handler registers as a todo case.
    if (body === undefined) return
    // A registration helper — `itInScratch(name, run)` — hands the runner a
    // body built from its own parameters. The assertions belong to each call
    // site, which this module cannot see, so the registration is not a case.
    if (referencesAny(body, injected)) return
    const shared = { file, line: lineOf(node, source), test: caseTitle(args[0], source) }
    const scan = scanBody(body)
    if (scan.empty) {
      found.push({
        ...shared,
        kind: 'empty-body',
        detail: 'the body runs no statements, so the runner records a pass for a case that tested nothing',
      })
      return
    }
    if (scan.asserts) return
    if (scan.calls.some(target => targetAsserts(module, graph, target, 1, new Set()))) return
    if (scan.listenerAsserts) {
      found.push({
        ...shared,
        kind: 'callback-only-assertion',
        detail: 'every assertion sits in a listener callback the case never forces to run,'
          + ' so the case passes when the event does not fire',
      })
      return
    }
    found.push({
      ...shared,
      kind: 'no-assertion',
      detail: 'the case reaches no assertion, so it passes whether or not the behavior its title names holds',
    })
  }
  const visit = (node: Node, injected: ReadonlySet<string>): void => {
    if (isCallExpression(node)) {
      const root = runnerRoot(node.expression)
      if (root !== undefined && RUNNER_NAMES.has(root) && !shadowed.has(root)) {
        record(node, injected)
        // The callee holds the modifier chain; only the arguments can nest a case.
        for (const argument of node.arguments) visit(argument, injected)
        return
      }
    }
    const names = parameterNames(node)
    const nested = names.length === 0 ? injected : new Set([...injected, ...names])
    node.forEachChild((child) => { visit(child, nested) })
  }
  source.forEachChild((child) => { visit(child, new Set()) })
  return found
}

/**
 * Find every assertionless case in one spec module.
 * @param file - repository-relative path, used in findings and import resolution.
 * @param source - raw TypeScript source.
 * @param resolveModule - resolver for relatively imported helper modules.
 * @returns every finding, in source order.
 */
export function scanAssertionlessTests(
  file: string,
  source: string,
  resolveModule: ModuleResolver = () => undefined,
): AssertionlessTestFinding[] {
  const graph = new ModuleGraph(resolveModule)
  const module: ParsedModule = { file, source: createSourceFile(file, source) }
  graph.seed(module)
  return collectAssertionlessTests(module, graph)
}


/**
 * Load every tracked spec file the rule applies to.
 * @param root - repository root.
 * @returns repository-relative path plus raw source, in glob order.
 */
export function assertionlessTestCandidateFiles(root: string = ROOT): TestModuleSource[] {
  const patterns = [
    'packages/*/*/tests/**/*.spec.ts',
    'packages/*/*/tests/**/*.spec.tsx',
    'apps/*/tests/**/*.spec.ts',
    'scripts/**/*.spec.ts',
  ]
  return uniqueRepoFiles(root, patterns, isEmittedOrVendored).map(({ abs }) => ({
    file: abs.slice(root.length + 1).split('\\').join('/'),
    source: readFileSync(abs, 'utf8'),
  }))
}

/**
 * Scan the live tree.
 * @param root - repository root.
 * @returns every assertionless case across tracked spec files.
 */
export function auditAssertionlessTests(root: string = ROOT): AssertionlessTestFinding[] {
  const candidates = assertionlessTestCandidateFiles(root)
  if (candidates.length === 0) return []
  const parsed = parsePaths(candidates.map(({ file }) => resolve(root, file)))
  const graph = new ModuleGraph(diskModuleResolver(root))
  const modules = candidates.map(({ file }) => {
    const source = parsed.get(resolve(root, file))
    if (source === undefined) throw new Error(`no-assertionless-tests: ${file} did not parse`)
    const module: ParsedModule = { file, source }
    graph.seed(module)
    return module
  })
  return modules.flatMap(module => collectAssertionlessTests(module, graph))
}
