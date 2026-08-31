/**
 * Reject product UI copy embedded directly in Client source.
 *
 * Locale dictionaries are the only source files allowed to own translated
 * text. Presentation code receives copy through its typed `t` seat or through
 * an already-localized prop. This check covers JSX text and copy-bearing
 * attributes, plus the common data/helper forms that feed them.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type {
  BindingName,
  CallExpression,
  Expression,
  Node,
  ParameterDeclaration,
  PropertyName,
  SourceFile,
} from 'typescript/unstable/ast'
import { SyntaxKind } from 'typescript/unstable/ast'
import {
  isArrayLiteralExpression,
  isArrayBindingPattern,
  isArrowFunction,
  isAsExpression,
  isBinaryExpression,
  isBindingElement,
  isCallExpression,
  isConditionalExpression,
  isExpression,
  isFunctionDeclaration,
  isPropertyAccessExpression,
  isFunctionExpression,
  isIdentifier,
  isJsxAttribute,
  isJsxElement,
  isJsxExpression,
  isJsxFragment,
  isJsxText,
  isMethodDeclaration,
  isNonNullExpression,
  isNoSubstitutionTemplateLiteral,
  isObjectLiteralExpression,
  isParenthesizedExpression,
  isPropertyAssignment,
  isReturnStatement,
  isSatisfiesExpression,
  isSourceFile,
  isStringLiteral,
  isTemplateExpression,
  isVariableDeclaration,
} from 'typescript/unstable/ast/is'
import { createSourceFile } from './ts7-session.ts'

const root = resolve(import.meta.dirname, '..')
const MINIMUM_CLIENT_UI_SOURCES = 450

const COPY_ATTRIBUTES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-valuetext',
  'cancelLabel',
  'closeLabel',
  'confirmLabel',
  'copyLabel',
  'description',
  'emptyLabel',
  'label',
  'placeholder',
  'title',
  'truncatedLabel',
])
const COPY_ATTRIBUTE_SUFFIX = /(?:Aria|Copy|Description|Heading|Label|Message|Placeholder|Summary|Text|Title|Tooltip)$/

const COPY_NAME = /(?:^|_)(?:aria|copy|description|empty|heading|label|message|placeholder|summary|text|title|tooltip)(?:s|_.*)?$/i
const COPY_SUFFIX = /(?:aria|copy|description|empty|heading|label|labels|message|placeholder|summary|text|title|tooltip|tabs)$/i
/**
 * The product wordmark. A brand name is the same in every locale — translating
 * it would be the defect — so it is not copy the dictionaries own.
 * See BRAND_GUIDELINES.md.
 */
const BRAND_TOKENS = new Set(['HARNESS', 'DeepSeek Harness', 'DSH'])

const IMMUTABLE_LANGUAGE_TOKENS = new Set([
  'Function',
  'K',
  'M',
  'MB',
  'Symbol',
  'false',
  'function()',
  'n',
  'null',
  'true',
  'undefined',
])
const LOCALE_KEY = /^[a-z][a-zA-Z0-9]*(?:[._-][a-zA-Z0-9]+)+$/

/**
 * Text that is not product copy, listed literally so the exemption cannot widen
 * on its own.
 *
 * Each entry is diagnostic text rather than copy a reader is meant to be shown
 * in their language. A crash message copied into the Host's model-visible
 * report is pinned verbatim by the model-facing-contract rule, and translating
 * it would break the very thing that rule protects; a realm label identifies a
 * browsing context to a developer tool. Keyed by exact text, so any other
 * string in the same file is still rejected.
 */
const NON_COPY_DIAGNOSTICS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  // Fallback identity for a tab whose `document.title` is empty, reported to
  // the inspector Worker as that realm's name.
  ['packages/experimental/inspector/src/client/bridge/controller.ts', new Set(['Client'])],
  // Stands in for a console argument that would not serialize; it is echoed
  // into the console mirror beside the developer's own output.
  [
    'packages/extensions/cordis-client-runner/src/client/evaluator.ts',
    new Set(['[unserializable console argument]']),
  ],
  // The render-failure line the Host keeps for the model across pages. The
  // panel does not paint it: it names the slot in the reader's own language and
  // appends `DynamicCordisRenderFailureView.cause`, which carries the crash
  // text without this framing.
  [
    'packages/extensions/cordis-client-runner/src/client/runtime.ts',
    new Set(['your entry in slot "" crashed while React rendered it:']),
  ],
])

/**
 * Whether one reported literal is listed as diagnostic text rather than copy.
 * @param file - repository-relative path of the file holding it.
 * @param text - compacted literal as the diagnostic would print it.
 * @returns true when the pair is listed.
 */
export function isNonCopyDiagnostic(file: string, text: string): boolean {
  return NON_COPY_DIAGNOSTICS.get(file.replaceAll('\\', '/'))?.has(text) === true
}

/** One hard-coded product-copy occurrence. */
export interface UiI18nViolation {
  /** One-based source column. */
  column: number
  /** Repository-relative source path. */
  file: string
  /** One-based source line. */
  line: number
  /** Why this literal is treated as product copy. */
  reason: string
  /** Compact literal text for the diagnostic. */
  text: string
}

/**
 * The browser fixture stands in for a server: every string it emits is invented
 * conversation content — session titles, assistant turns, tool failures — not
 * chrome the product renders, so the copy rules do not reach it. Named as one
 * file rather than a pattern, so no component can inherit the exemption.
 */
const FIXTURE_CONTENT_OWNER = 'packages/client/connection/src/client/fixture.ts'

function localeOwner(file: string): boolean {
  if (file.replaceAll('\\', '/') === FIXTURE_CONTENT_OWNER) return true
  const normalized = file.replaceAll('\\', '/')
  const base = normalized.slice(normalized.lastIndexOf('/') + 1)
  return base === 'locale.ts'
    || base === 'locales.ts'
    || normalized.includes('/locales/')
}

function normalizeCopy(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/** Tag syntax in an HTML template, which carries structure rather than copy. */
const MARKUP_TAG = /<[a-z!/][^>]*>/gi

/** Attribute values inside a tag that a reader is shown. */
const MARKUP_COPY_ATTRIBUTE
  = /(?<![-\w])(?:aria-(?:label|description|roledescription|placeholder|valuetext)|alt|placeholder|title)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi

/**
 * Reduce an HTML template to the text it actually shows.
 *
 * A template that interpolates its copy is left holding only tags, and tag
 * names are not copy. Text between tags is kept, and so are the attribute
 * values a reader is shown, so copy written inline is still rejected.
 * @param text - literal text as written.
 * @returns the same text when it holds no markup, else its reader-visible part.
 */
function markupText(text: string): string {
  if (!MARKUP_TAG.test(text)) return text
  MARKUP_TAG.lastIndex = 0
  // A template is written inside backticks, so its attributes are as often
  // single-quoted as double-quoted; both carry the same copy.
  const attributes = [...text.matchAll(MARKUP_COPY_ATTRIBUTE)].map(match => match[1] ?? match[2] ?? '')
  return [text.replaceAll(MARKUP_TAG, ' '), ...attributes].join(' ')
}

function containsProductText(text: string): boolean {
  const normalized = normalizeCopy(text)
  return normalized !== ''
    && !IMMUTABLE_LANGUAGE_TOKENS.has(normalized)
    && !BRAND_TOKENS.has(normalized)
    && !LOCALE_KEY.test(normalized)
    && /\p{L}/u.test(normalized)
}

function propertyName(node: PropertyName | BindingName): string | undefined {
  return isIdentifier(node) || isStringLiteral(node) ? node.text : undefined
}

function isCopyName(name: string | undefined): boolean {
  return name !== undefined && (COPY_NAME.test(name) || COPY_SUFFIX.test(name))
}

function copyAttribute(name: string): boolean {
  return !name.endsWith('Key')
    && (COPY_ATTRIBUTES.has(name) || COPY_ATTRIBUTE_SUFFIX.test(name))
}

function compactText(text: string): string {
  const normalized = normalizeCopy(text)
  return normalized.length <= 80 ? normalized : `${normalized.slice(0, 77)}...`
}

function looksLikeNaturalText(text: string): boolean {
  const normalized = normalizeCopy(text)
  return /\s|[\u3400-\u9fff]/u.test(normalized) || /^[A-Z]/.test(normalized)
}

/** DOM properties whose assigned value is painted for a person to read. */
const TEXT_SINK_PROPERTIES = new Set([
  'textContent', 'innerText', 'innerHTML', 'outerText', 'placeholder', 'title', 'alt',
  'ariaLabel', 'ariaDescription', 'ariaPlaceholder', 'ariaValueText', 'label',
])

/** Methods that paint one argument, paired with the index of that argument. */
const TEXT_SINK_METHODS = new Map([
  ['insertAdjacentText', 1],
  ['insertAdjacentHTML', 1],
  ['createTextNode', 0],
  ['createComment', 0],
])

/** Methods that paint every string argument they are handed. */
const TEXT_SINK_VARIADICS = new Set(['append', 'prepend', 'replaceChildren', 'before', 'after'])

/**
 * Text a call paints, if it paints any.
 * @param node - call to classify.
 * @returns the painted argument expressions, empty when the call paints none.
 */
function paintedArguments(node: CallExpression): readonly Expression[] {
  if (!isPropertyAccessExpression(node.expression)) return []
  const method = node.expression.name.text
  const fixed = TEXT_SINK_METHODS.get(method)
  if (fixed !== undefined) {
    const argument = node.arguments[fixed]
    return argument === undefined ? [] : [argument]
  }
  if (TEXT_SINK_VARIADICS.has(method)) return node.arguments
  // `setAttribute` names its own sink, so only the copy-bearing attributes
  // count; `data-*` and `id` carry no reader-visible text.
  if (method === 'setAttribute') {
    const attribute = node.arguments[0]
    const value = node.arguments[1]
    if (attribute === undefined || value === undefined) return []
    if (!isStringLiteral(attribute) || !copyAttribute(attribute.text)) return []
    return [value]
  }
  return []
}

/**
 * Functions in one file that write a parameter straight to a DOM text sink.
 *
 * A sink may be written as a declaration, a method, or an arrow bound to a
 * name, and may paint more than one of its parameters, so all three forms are
 * read and every painted position is kept.
 * @param source - parsed file.
 * @returns function name paired with the parameter positions it paints.
 */
function textSinkParameters(source: SourceFile): Map<string, Set<number>> {
  const sinks = new Map<string, Set<number>>()
  const record = (name: string, parameters: readonly (string | undefined)[], body: Node): void => {
    const paints = (candidate: Node): void => {
      if (!isIdentifier(candidate)) return
      const index = parameters.indexOf(candidate.text)
      if (index < 0) return
      const held = sinks.get(name) ?? new Set<number>()
      held.add(index)
      sinks.set(name, held)
    }
    const findAssignment = (inner: Node): void => {
      if (isBinaryExpression(inner)
        && inner.operatorToken.kind === SyntaxKind.EqualsToken
        && isPropertyAccessExpression(inner.left)
        && TEXT_SINK_PROPERTIES.has(inner.left.name.text)) paints(inner.right)
      if (isCallExpression(inner)) for (const painted of paintedArguments(inner)) paints(painted)
      inner.forEachChild(findAssignment)
    }
    findAssignment(body)
  }
  const parametersOf = (declaration: { readonly parameters: readonly ParameterDeclaration[] }) =>
    declaration.parameters.map(parameter =>
      (isIdentifier(parameter.name) ? parameter.name.text : undefined))
  const visit = (node: Node): void => {
    if ((isFunctionDeclaration(node) || isMethodDeclaration(node)) && node.name !== undefined) {
      record(propertyName(node.name) ?? '', parametersOf(node), node)
    } else if (isVariableDeclaration(node)
      && node.initializer !== undefined
      && (isArrowFunction(node.initializer) || isFunctionExpression(node.initializer))) {
      record(propertyName(node.name) ?? '', parametersOf(node.initializer), node.initializer)
    }
    node.forEachChild(visit)
  }
  visit(source)
  sinks.delete('')
  return sinks
}

/**
 * Find hard-coded product copy in one Client source file.
 * @param file - repository-relative path used in diagnostics.
 * @param sourceText - TypeScript or TSX source.
 * @returns violations in source order.
 */

/**
 * Whether a lone token is a machine value rather than a word someone reads.
 *
 * State holds both. `ArrowRight` and `plugin-card-open` are a key and an id;
 * `Saved` and `Retry` are copy, and excluding every single word to be rid of
 * the first two would let real one-word copy through here while the attribute
 * and DOM-property rules still reject it.
 * @param text - literal as written.
 * @returns true when the token reads as an identifier, not as a word.
 */
function isMachineToken(text: string): boolean {
  const normalized = normalizeCopy(text)
  if (/\s|[\u3400-\u9fff]/u.test(normalized)) return false
  // One word, so the shape decides: an inner capital, a separator, or a digit
  // is how identifiers are written and how words are not.
  return /[-_.\d]/.test(normalized) || /\w[A-Z]/.test(normalized)
}

/**
 * Names bound as the setter half of a `useState` pair in one file.
 *
 * Copy often reaches the screen without ever touching a DOM sink or a JSX
 * literal: it is put into component state and rendered later as `{value}`. The
 * setter is where that copy is written down, and the pair's own destructuring
 * names it, so no naming convention has to be guessed.
 * @param source - parsed file.
 * @returns every setter name the file binds.
 */
function stateSetters(source: SourceFile): Set<string> {
  const setters = new Set<string>()
  const visit = (node: Node): void => {
    if (isVariableDeclaration(node)
      && node.initializer !== undefined
      && isCallExpression(node.initializer)
      && /^use\w*State$/.test(node.initializer.expression.getText(source))
      && isArrayBindingPattern(node.name)) {
      const setter = node.name.elements[1]
      if (setter !== undefined && isBindingElement(setter)
        && setter.name !== undefined && isIdentifier(setter.name)) {
        setters.add(setter.name.text)
      }
    }
    node.forEachChild(visit)
  }
  visit(source)
  return setters
}

export function findUiI18nViolations(file: string, sourceText: string): UiI18nViolation[] {
  if (localeOwner(file)) return []
  const source = createSourceFile(file.endsWith('.tsx') || file.endsWith('.ts') ? file : `${file}.ts`, sourceText)
  const violations = new Map<number, UiI18nViolation>()

  const report = (
    node: Node,
    text: string,
    reason: string,
    naturalOnly = false,
  ) => {
    const visible = markupText(text)
    if (
      !containsProductText(visible)
      || (naturalOnly && !looksLikeNaturalText(visible))
      || violations.has(node.getStart(source))
    ) return
    const position = source.getLineAndCharacterOfPosition(node.getStart(source))
    violations.set(node.getStart(source), {
      column: position.character + 1,
      file,
      line: position.line + 1,
      reason,
      text: compactText(text),
    })
  }

  const collectExpression = (
    node: Expression,
    reason: string,
    naturalOnly = false,
  ) => {
    if (isStringLiteral(node) || isNoSubstitutionTemplateLiteral(node)) {
      report(node, node.text, reason, naturalOnly)
      return
    }
    if (isTemplateExpression(node)) {
      report(
        node,
        [node.head.text, ...node.templateSpans.map(span => span.literal.text)].join(''),
        reason,
        naturalOnly,
      )
      return
    }
    if (isCallExpression(node)) {
      return
    }
    if (
      isParenthesizedExpression(node)
      || isAsExpression(node)
      || isSatisfiesExpression(node)
      || isNonNullExpression(node)
    ) {
      collectExpression(node.expression, reason, naturalOnly)
      return
    }
    if (isConditionalExpression(node)) {
      collectExpression(node.whenTrue, reason, naturalOnly)
      collectExpression(node.whenFalse, reason, naturalOnly)
      return
    }
    if (isBinaryExpression(node)) {
      if (node.operatorToken.kind === SyntaxKind.AmpersandAmpersandToken) {
        collectExpression(node.right, reason, naturalOnly)
      } else if (
        node.operatorToken.kind === SyntaxKind.PlusToken
        || node.operatorToken.kind === SyntaxKind.BarBarToken
        || node.operatorToken.kind === SyntaxKind.QuestionQuestionToken
      ) {
        collectExpression(node.left, reason, naturalOnly)
        collectExpression(node.right, reason, naturalOnly)
      }
      return
    }
    if (isArrayLiteralExpression(node)) {
      for (const element of node.elements) {
        if (isExpression(element)) collectExpression(element, reason, naturalOnly)
      }
      return
    }
    if (isObjectLiteralExpression(node)) {
      for (const property of node.properties) {
        if (isPropertyAssignment(property)) {
          const propertyOwnsCopy = isCopyName(propertyName(property.name))
          collectExpression(property.initializer, reason, naturalOnly || !propertyOwnsCopy)
        }
      }
    }
  }

  const collectNamedCopy = (
    name: PropertyName | BindingName,
    initializer: Expression,
    role: string,
  ): void => {
    const label = propertyName(name)
    if (isCopyName(label)) collectExpression(initializer, `${label} ${role}`)
  }

  const enclosingFunctionName = (node: Node): string | undefined => {
    let current = node.parent
    while (!isSourceFile(current)) {
      if (isFunctionDeclaration(current) || isMethodDeclaration(current)) {
        return current.name === undefined ? undefined : propertyName(current.name)
      }
      if (isArrowFunction(current) || isFunctionExpression(current)) {
        const parent = current.parent
        return isVariableDeclaration(parent) ? propertyName(parent.name) : undefined
      }
      current = current.parent
    }
    return undefined
  }

  const hasExplicitStringReturn = (node: Node): boolean => {
    let current = node.parent
    while (!isSourceFile(current)) {
      if (
        isFunctionDeclaration(current)
        || isMethodDeclaration(current)
        || isArrowFunction(current)
        || isFunctionExpression(current)
      ) return current.type?.kind === SyntaxKind.StringKeyword
      current = current.parent
    }
    return false
  }

  const visit = (node: Node) => {
    if (isJsxText(node)) report(node, node.text, 'JSX text')

    // The plainest form of painted copy, and the one no rule below sees: a
    // literal written straight onto the element. Tracing helper parameters
    // only ever caught copy that took a detour through one.
    if (isBinaryExpression(node)
      && node.operatorToken.kind === SyntaxKind.EqualsToken
      && isPropertyAccessExpression(node.left)
      && TEXT_SINK_PROPERTIES.has(node.left.name.text)) {
      collectExpression(node.right, `${node.left.name.text} assignment`)
    }

    if (isCallExpression(node)) {
      for (const painted of paintedArguments(node)) {
        collectExpression(painted, `${node.expression.getText(source).split('.').pop() ?? ''}() text argument`)
      }
    }

    if (isJsxAttribute(node)) {
      const name = node.name.getText(source)
      if (copyAttribute(name) && node.initializer !== undefined) {
        if (isStringLiteral(node.initializer)) report(node.initializer, node.initializer.text, `${name} attribute`)
        else if (isJsxExpression(node.initializer) && node.initializer.expression !== undefined) {
          collectExpression(node.initializer.expression, `${name} attribute`)
        }
      }
    }

    if (
      isJsxExpression(node)
      && node.expression !== undefined
      && (isJsxElement(node.parent) || isJsxFragment(node.parent))
    ) collectExpression(node.expression, 'JSX child')

    if (file.endsWith('.tsx') && isPropertyAssignment(node)) {
      collectNamedCopy(node.name, node.initializer, 'property')
    }

    if (isVariableDeclaration(node) && node.initializer !== undefined) {
      collectNamedCopy(node.name, node.initializer, 'value')
    }

    if (isBindingElement(node) && node.initializer !== undefined && node.name !== undefined) {
      collectNamedCopy(node.name, node.initializer, 'default value')
    }

    if (isReturnStatement(node) && node.expression !== undefined) {
      const name = enclosingFunctionName(node)
      if (isCopyName(name)) {
        collectExpression(node.expression, `${name} return value`)
      } else if (file.endsWith('.tsx') && hasExplicitStringReturn(node)) {
        collectExpression(node.expression, 'string return value', true)
      }
    }

    node.forEachChild(visit)
  }
  visit(source)

  // A helper that writes one of its parameters straight to `textContent` is a
  // text sink: a literal handed to it at a call site is painted copy, however
  // plainly the call reads. The boot shell paints entirely this way, and no
  // rule above sees a positional argument.
  // A literal written into component state is painted wherever that state is
  // rendered, which no rule above can see from the assignment alone. Only
  // sentence-shaped text counts here: state also holds ids and status tags.
  const setters = stateSetters(source)
  if (setters.size > 0) {
    const collectStateCopy = (node: Node): void => {
      const isSetterCall = isCallExpression(node)
        && isIdentifier(node.expression)
        && setters.has(node.expression.text)
      // `useState('Saved your work')` seeds the same state the setter writes.
      const isStateSeed = isCallExpression(node)
        && /^use\w*State$/.test(node.expression.getText(source))
      if (isCallExpression(node) && (isSetterCall || isStateSeed)) {
        const literals = (inner: Node): void => {
          if ((isStringLiteral(inner) || isNoSubstitutionTemplateLiteral(inner))
            && !isMachineToken(inner.text)) {
            report(inner, inner.text, `${node.expression.getText(source)}() state copy`, true)
          }
          inner.forEachChild(literals)
        }
        for (const argument of node.arguments) literals(argument)
      }
      node.forEachChild(collectStateCopy)
    }
    collectStateCopy(source)
  }

  for (const [name, indexes] of textSinkParameters(source)) {
    const collectSinkCalls = (node: Node): void => {
      // A sink is called bare or through a receiver (`view.paint(...)`); the
      // name is the one this file defined as a sink either way.
      const callee = isCallExpression(node)
        && (isIdentifier(node.expression)
          ? node.expression.text
          : isPropertyAccessExpression(node.expression) ? node.expression.name.text : undefined)
      if (isCallExpression(node) && callee === name) {
        for (const index of indexes) {
          const argument = node.arguments[index]
          if (argument !== undefined) collectExpression(argument, `${name}() text argument`)
        }
      }
      node.forEachChild(collectSinkCalls)
    }
    collectSinkCalls(source)
  }
  return [...violations.values()]
    .filter(violation => !isNonCopyDiagnostic(file, violation.text))
    .sort((left, right) => left.line - right.line || left.column - right.column)
}

function sourceFiles(): string[] {
  return [...new Set([
    // Every Client package, not only `ui-*`: the web shell's own `.ts` files
    // paint user-visible copy too (the boot page is pure TypeScript).
    ...globSync('packages/client/*/src/**/*.{ts,tsx}', { cwd: root }),
    // Every `src/client` tree in the repository, not only the ones holding a
    // `.tsx`: a package that paints through the DOM directly has no component
    // file to be found by, and its copy is as user-visible as any other.
    ...globSync('packages/*/*/src/client/**/*.{ts,tsx}', { cwd: root }),
    ...globSync('apps/web/src/**/*.{ts,tsx}', { cwd: root }),
  ])]
    .map(file => file.replaceAll('\\', '/'))
    .filter(file => !file.endsWith('.d.ts'))
    .sort()
}

function main(): void {
  const files = sourceFiles()
  if (files.length < MINIMUM_CLIENT_UI_SOURCES) {
    throw new Error(
      `verify-client-ui-i18n: discovery narrowed to ${files.length} source file(s); expected at least ${MINIMUM_CLIENT_UI_SOURCES}.`,
    )
  }
  const violations = files.flatMap(file =>
    findUiI18nViolations(file, readFileSync(resolve(root, file), 'utf8')))
  if (violations.length > 0) {
    console.error(`verify-client-ui-i18n: ${violations.length} hard-coded UI string(s):`)
    for (const violation of violations) {
      console.error(
        `  ${violation.file}:${violation.line}:${violation.column} ${violation.reason}: ${JSON.stringify(violation.text)}`,
      )
    }
    process.exitCode = 1
    return
  }
  console.log(`verify-client-ui-i18n: ${files.length} Client UI source file(s) use locale-owned copy.`)
}

if (import.meta.filename === resolve(process.argv[1] ?? '')) main()
