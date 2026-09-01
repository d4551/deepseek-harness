/**
 * Fail-capable scan of the CSS-Modules / `--dsw-*` styling SSOT: forbidden
 * stacks, token bypass, a second page shell, float layout, inline scripts,
 * missing theme focus/motion, and undersized interactive geometry.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { uniqueRepoFiles } from './repo-files.ts'
import { cssRules, declaresInfiniteAnimation, selectorParts, stopsAnimation, stripCssComments } from './ui-ssot-css.ts'

const ROOT = resolve(import.meta.dirname, '..')

/** One SSOT miss. */
export interface SsotFinding {
  /** Repository-relative path, or the fixture name. */
  file: string
  /** Detector that fired. */
  kind:
    | 'forbidden-stack'
    | 'token-bypass'
    | 'inline-script'
    | 'one-off-script'
    | 'shell-drift'
    | 'alignment'
    | 'focus-visible'
    | 'reduced-motion'
    | 'hit-target'
    | 'dangling-token'
    | 'tsx-inline-color'
  /** Why it fired. */
  detail: string
}

const THEME_STYLES_DIR = 'packages/client/ui-theme/src/styles/'
const APP_FRAME_CSS = 'packages/client/ui-layout/src/client/AppFrame.module.css'
const WEB_ENTRY = 'apps/web/src/main.ts'

const FORBIDDEN = /\b(daisyui|tailwindcss|htmx\.org|@tailwind|hx-(?:get|post|put|patch|delete|swap|trigger|boost|target))\b/
const COLOR_NAME = '(?:color|background(?:-color)?|border(?:-color)?|fill|stroke|outline-color)'
const COLOR_PROP = new RegExp(
  String.raw`(?:^|[;{\s])${COLOR_NAME}\s*:\s*(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\()`,
  'i',
)
const PAGE_SHELL = /(?:html|body|#root)\s*\{[^}]*display\s*:\s*grid/i
const FRAME_GRID = /\.frame\s*\{[^}]*display\s*:\s*grid/i
const FLOAT_LAYOUT = /float\s*:\s*(?:left|right)/i
// A literal color inside a TSX style object (painted property in camelCase)
// or an SVG presentation attribute. Theme-dir sheets declare tokens; TSX
// never does, so the whole extension family is one bypass channel.
const TSX_HEX = String.raw`#[0-9a-fA-F]{3,8}`
const TSX_COLOR_OBJECT = new RegExp(
  String.raw`(?:color|backgroundColor|borderColor|fill|stroke|outline(?:Color)?)\s*:\s*(['"])`
  + String.raw`(${TSX_HEX}|rgba?\(|hsla?\(|oklch\()`,
  'g',
)
const TSX_COLOR_ATTR = new RegExp(
  String.raw`\b(fill|stroke|color)\s*=\s*(['"])(${TSX_HEX}|rgba?\([^)]*\)|hsla?\([^)]*\)|oklch\([^)]*\))\2`,
  'g',
)
// Generic markup-tag matcher; the captured tag name decides the rule, the
// same shape verify-client-ui-i18n uses, so HTML is read as markup rather
// than patterned per tag.
const MARKUP_TAG = /<\s*([a-z][a-z0-9:-]*)\b([^>]*)>/gi
const SCRIPT_IS_MODULE = /\btype\s*=\s*['"]module['"]/i
const ON_HANDLER = /\son(?:click|load|error|submit)\s*=/i
const INTERACTIVE = /(?:^|,)\s*(?:button|\[role=['"]button['"]\]|\.button)[^{]*\{([^}]*)\}/gi
const PX_SIZE = /(?:width|height|min-width|min-height)\s*:\s*(\d+)px/gi

function themeSheets(files: readonly { file: string; content: string }[]): string {
  return files
    .filter(({ file }) => file.replaceAll('\\', '/').startsWith(THEME_STYLES_DIR) && file.endsWith('.css'))
    .map(({ content }) => content)
    .join('\n')
}

/**
 * Whether an HTML document carries an inline or non-module script tag.
 *
 * The Vite entry is the only sanctioned script: a tag without
 * `type="module"`, or one whose body holds markup text instead of closing
 * immediately, is per-page JS outside the shared modules.
 * @param html - document text.
 * @returns true when such a tag exists.
 */
function hasInlineScript(html: string): boolean {
  MARKUP_TAG.lastIndex = 0
  let tag: RegExpExecArray | null
  while ((tag = MARKUP_TAG.exec(html)) !== null) {
    const [raw, name, attrs] = tag
    if (name?.toLowerCase() !== 'script') continue
    if (!SCRIPT_IS_MODULE.test(attrs ?? '')) return true
    const after = html.slice(tag.index + raw.length)
    if (/^\s*[^<\s]/.test(after)) return true
  }
  return false
}

/**
 * Scan a file set (live tree or injected fixtures) for SSOT misses.
 * @param files - path plus content.
 * @returns every finding.
 */
export function scanUiSsot(files: readonly { file: string; content: string }[]): SsotFinding[] {
  const findings: SsotFinding[] = []
  const sheets = themeSheets(files)
  if (!/:focus-visible\b/.test(sheets)) {
    findings.push({
      file: THEME_STYLES_DIR,
      kind: 'focus-visible',
      detail: 'ui-theme styles must define :focus-visible for interactive controls',
    })
  }
  if (!/prefers-reduced-motion/.test(sheets) || !/--ds-transition-duration:\s*0\.01ms/.test(sheets)) {
    findings.push({
      file: THEME_STYLES_DIR,
      kind: 'reduced-motion',
      detail: 'ui-theme must collapse --ds-transition-duration* under prefers-reduced-motion',
    })
  }

  const frame = files.find(({ file }) => file.replaceAll('\\', '/') === APP_FRAME_CSS)
  if (frame !== undefined && !FRAME_GRID.test(stripCssComments(frame.content))) {
    findings.push({
      file: APP_FRAME_CSS,
      kind: 'shell-drift',
      detail: 'AppFrame .frame must be display: grid',
    })
  }

  for (const { file, content } of files) {
    const path = file.replaceAll('\\', '/')
    const css = path.endsWith('.css') ? stripCssComments(content) : content

    if (FORBIDDEN.test(content)) {
      findings.push({ file: path, kind: 'forbidden-stack', detail: 'Tailwind, daisyUI, or htmx token in product UI' })
    }

    if (path.endsWith('.css') && !path.startsWith(THEME_STYLES_DIR) && COLOR_PROP.test(css)) {
      findings.push({ file: path, kind: 'token-bypass', detail: 'literal color on a painted property; use --dsw-* tokens' })
    }

    if (path.endsWith('.css') && !path.includes('ui-layout/') && PAGE_SHELL.test(css)) {
      findings.push({ file: path, kind: 'shell-drift', detail: 'second page shell (html/body/#root grid) outside ui-layout' })
    }

    if (path.endsWith('.css') && FLOAT_LAYOUT.test(css)) {
      findings.push({ file: path, kind: 'alignment', detail: 'float layout; use the AppFrame grid or flex in-module' })
    }

    if (/\.html?$/.test(path) && (hasInlineScript(content) || ON_HANDLER.test(content))) {
      findings.push({ file: path, kind: 'inline-script', detail: 'inline or non-module script / HTML handler outside the Vite entry' })
    }

    if (path.startsWith('apps/web/src/') && path.endsWith('.js') && !path.endsWith('node-module-stub.js')) {
      findings.push({ file: path, kind: 'one-off-script', detail: `per-page helper outside ${WEB_ENTRY}` })
    }

    if (path.endsWith('.tsx')) {
      TSX_COLOR_OBJECT.lastIndex = 0
      if (TSX_COLOR_OBJECT.test(content)) {
        findings.push({ file: path, kind: 'tsx-inline-color', detail: 'literal color in a TSX style object; use --dsw-* tokens in a CSS Module' })
      }
      TSX_COLOR_ATTR.lastIndex = 0
      if (TSX_COLOR_ATTR.test(content)) {
        findings.push({ file: path, kind: 'tsx-inline-color', detail: 'literal hex in an SVG color attribute; use a CSS Module class or currentColor' })
      }
    }

    if (path.endsWith('.css')) {
      INTERACTIVE.lastIndex = 0
      let block: RegExpExecArray | null
      while ((block = INTERACTIVE.exec(css)) !== null) {
        const body = block[1] ?? ''
        const sizes: number[] = []
        PX_SIZE.lastIndex = 0
        let size: RegExpExecArray | null
        while ((size = PX_SIZE.exec(body)) !== null) {
          if (size[1] !== undefined) sizes.push(Number(size[1]))
        }
        if (sizes.length >= 2 && sizes.every(px => px < 24)) {
          findings.push({
            file: path,
            kind: 'hit-target',
            detail: `interactive geometry ${sizes.join('x')}px is below WCAG 2.5.8 24px`,
          })
        }
      }
    }
  }

  // An `animation` shorthand carries its own literal duration, so the theme's
  // reduced-motion collapse of `--ds-transition-duration*` never reaches it. A
  // loop that never ends is precisely the motion that setting asks to stop, so
  // every selector declaring one has to be answered by name: a guard somewhere
  // in the sheet says nothing about the selector actually moving, a guard the
  // animated rule overrides is dead in the cascade, and a media block that
  // merely opens and restyles a colour stops nothing.
  for (const { file: path, content } of files) {
    const rules = cssRules(stripCssComments(content))
    const guards = rules.filter(rule => rule.reduced && !rule.conditional && stopsAnimation(rule.body))
    for (const rule of rules) {
      if (rule.reduced || !declaresInfiniteAnimation(rule.body)) continue
      for (const part of selectorParts(rule.selector)) {
        const answered = guards.some(guard => guard.start > rule.start
          && selectorParts(guard.selector).some(target => target === part || target === '*'))
        if (answered) continue
        findings.push({
          file: path,
          kind: 'reduced-motion',
          detail: `\`${part}\` animates forever with no prefers-reduced-motion rule stopping it`,
        })
      }
    }
  }

  // Corpus-level, not per-file: a token is declared in the theme sheet and used
  // anywhere else. An undefined `var()` resolves to nothing, which drops the
  // whole declaration — error copy loses its colour, `1px solid var(...)` loses
  // its border — and no single-file rule can see that.
  const declared = new Set<string>()
  for (const { content } of files) {
    const text = stripCssComments(content)
    // A declaration is a CSS property, an object-literal key, or a quoted name
    // handed to `setProperty` — the `--dsh-*` band is published from TypeScript
    // as often as from a stylesheet, and both are equally a definition.
    for (const match of text.matchAll(/(--ds[wh]-[\w-]+)\s*:/g)) declared.add(match[1] ?? '')
    for (const match of text.matchAll(/['"](--ds[wh]-[\w-]+)['"]/g)) declared.add(match[1] ?? '')
  }
  for (const { file: path, content } of files) {
    const reported = new Set<string>()
    for (const match of stripCssComments(content).matchAll(/var\(\s*(--ds[wh]-[\w-]+)/g)) {
      const token = match[1] ?? ''
      if (declared.has(token) || reported.has(token)) continue
      reported.add(token)
      findings.push({
        file: path,
        kind: 'dangling-token',
        detail: `var(${token}) names no declared token; a fallback only hides the missing SSOT entry`,
      })
    }
  }

  return findings
}

/**
 * Load the live client/web UI files the SSOT scan covers.
 * @param root - repository root.
 * @returns path plus content.
 */
export function loadUiSsotCorpus(root: string = ROOT): { file: string; content: string }[] {
  return uniqueRepoFiles(root, [
    // `.ts` too: the `--dsh-*` band is published from TypeScript via
    // `setProperty` and inline style objects, so a corpus without it reads
    // every such token as undeclared.
    'packages/client/*/src/**/*.{css,ts,tsx,html}',
    'packages/client/*/src/styles/*.css',
    // Extension and prototype panels paint with the same design tokens, so they
    // answer to the same SSOT — a typo'd token is as broken there as anywhere.
    'packages/extensions/*/src/**/*.{css,tsx,html}',
    'packages/experimental/*/src/**/*.{css,tsx,html}',
    'apps/web/src/**/*.{ts,tsx,css,html,js}',
    'apps/web/index.html',
  ], relativePath => relativePath.includes('node_modules/') || relativePath.includes('/tests/') || relativePath.includes('/lib/'))
    .map(({ abs }) => {
      const file = abs.slice(root.length + 1).split('\\').join('/')
      return { file, content: readFileSync(abs, 'utf8') }
    })
}
