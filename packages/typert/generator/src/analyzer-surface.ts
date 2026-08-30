/**
 * Lexical Typert surface detection without a type-checker program.
 */

import { dirname, resolve } from 'node:path'
import { existsSync } from 'node:fs'

/** A cordis module augmentation header, the one marker an empty body can carry. */
const CORDIS_AUGMENTATION = /declare\s+module\s+['"]@deepseek-ai\/cordis['"]/u

/**
 * Lexical markers a file must contain before it can carry a Typert or Cordis
 * surface: `@typert` documentation tags, a Cordis module augmentation, a
 * `typertRemote` binding, or a `Remote`/`RemoteScope` decorator.
 */
const SURFACE_MARKERS: readonly RegExp[] = [
  /@typert\b/u,
  CORDIS_AUGMENTATION,
  /\btypertRemote\b/u,
  /@(?:Remote|RemoteScope)\b/u,
]

/**
 * Whether source text can declare a Typert or Cordis surface at all. A file
 * without any marker cannot contribute services, events, or @typert roots;
 * a false positive only admits the package to full analysis, which is
 * authoritative.
 * @param text - source file contents.
 * @returns true when the text carries a surface marker.
 */
export function textMayCarrySurface(text: string): boolean {
  return SURFACE_MARKERS.some(marker => marker.test(text))
}


/**
 * Whether a cordis augmentation is the only marker in this text, and every
 * interface it declares is empty.
 *
 * An empty augmentation contributes no service, event, or root, so a package
 * whose whole surface is one is not a Typert package. Every other marker
 * admits the file, because only full analysis can judge those.
 * @param text - source file contents.
 * @returns true when the text's sole marker is an augmentation with no members.
 */
export function onlyEmptyCordisAugmentation(text: string): boolean {
  if (SURFACE_MARKERS.some(marker => marker !== CORDIS_AUGMENTATION && marker.test(text))) return false
  if (!CORDIS_AUGMENTATION.test(text)) return false
  return !/\binterface\s+[A-Za-z_$][\w$]*\s*(?:<[^>]*>\s*)?\{\s*[^\s}]/u.test(text)
}

/**
 * Relative import specifiers in source text: static imports, re-exports,
 * side-effect imports, and `require` calls with string literals.
 * @param text - source file contents.
 * @returns relative specifiers such as `./models` in source order.
 */
export function localImportSpecifiers(text: string): string[] {
  const specifiers: string[] = []
  for (const match of text.matchAll(/(?:from|import|require)\s*['"](\.[^'"]+)['"]/gu)) {
    const spec = match[1]
    if (spec !== undefined) specifiers.push(spec)
  }
  return specifiers
}

/**
 * Resolve one relative import specifier against the importing file.
 * @param fromFile - absolute path of the importing file.
 * @param spec - relative specifier such as `./models`.
 * @returns the first existing TypeScript target, or undefined.
 */
export function resolveLocalImport(fromFile: string, spec: string): string | undefined {
  const resolved = resolve(dirname(fromFile), spec)
  for (const candidate of [
    resolved,
    `${resolved}.ts`,
    `${resolved}.tsx`,
    resolve(resolved, 'index.ts'),
    resolve(resolved, 'index.tsx'),
  ]) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

/**
 * Relative import targets from one file's text, resolved against disk.
 * @param text - source file contents.
 * @param fromFile - absolute path of that file.
 * @returns existing in-package TypeScript files the module imports or re-exports.
 */
export function localImportTargetsInText(text: string, fromFile: string): string[] {
  const targets: string[] = []
  for (const spec of localImportSpecifiers(text)) {
    const target = resolveLocalImport(fromFile, spec)
    if (target !== undefined) targets.push(target)
  }
  return targets
}
