/**
 * Fail-capable scan of the CSS-Modules / `--dsw-*` styling SSOT: forbidden
 * stacks, token bypass, a second page shell, float layout, inline scripts,
 * missing theme focus/motion, and undersized interactive geometry.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { uniqueRepoFiles } from './repo-files.ts'

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
const INLINE_SCRIPT = /<script(?![^>]*\btype\s*=\s*['"]module['"])[^>]*>/i
const INLINE_SCRIPT_BODY = /<script\b[^>]*>\s*[^<\s]/i
const ON_HANDLER = /\son(?:click|load|error|submit)\s*=/i
const INTERACTIVE = /(?:^|,)\s*(?:button|\[role=['"]button['"]\]|\.button)[^{]*\{([^}]*)\}/gi
const PX_SIZE = /(?:width|height|min-width|min-height)\s*:\s*(\d+)px/gi

/**
 * Strip CSS comments so a mentioned hex in a caption is not a bypass.
 * @param css - stylesheet text.
 * @returns comment-free text.
 */
export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ')
}

function themeSheets(files: readonly { file: string; content: string }[]): string {
  return files
    .filter(({ file }) => file.replaceAll('\\', '/').startsWith(THEME_STYLES_DIR) && file.endsWith('.css'))
    .map(({ content }) => content)
    .join('\n')
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

    if (/\.html?$/.test(path) && (INLINE_SCRIPT.test(content) || INLINE_SCRIPT_BODY.test(content) || ON_HANDLER.test(content))) {
      findings.push({ file: path, kind: 'inline-script', detail: 'inline or non-module script / HTML handler outside the Vite entry' })
    }

    if (path.startsWith('apps/web/src/') && path.endsWith('.js') && !path.endsWith('node-module-stub.js')) {
      findings.push({ file: path, kind: 'one-off-script', detail: `per-page helper outside ${WEB_ENTRY}` })
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

  return findings
}

/**
 * Load the live client/web UI files the SSOT scan covers.
 * @param root - repository root.
 * @returns path plus content.
 */
export function loadUiSsotCorpus(root: string = ROOT): { file: string; content: string }[] {
  return uniqueRepoFiles(root, [
    'packages/client/*/src/**/*.{css,tsx,html}',
    'packages/client/*/src/styles/*.css',
    'apps/web/src/**/*.{ts,tsx,css,html,js}',
    'apps/web/index.html',
  ], relativePath => relativePath.includes('node_modules/') || relativePath.includes('/tests/') || relativePath.includes('/lib/'))
    .map(({ abs }) => {
      const file = abs.slice(root.length + 1).split('\\').join('/')
      return { file, content: readFileSync(abs, 'utf8') }
    })
}
