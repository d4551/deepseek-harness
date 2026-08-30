/**
 * Shared text helpers for the Typert emitters: identifier normalization,
 * string literal quoting, and block indentation.
 */

/**
 * Turn one exported or wire name into a valid JavaScript identifier.
 * @param name - exported or wire name.
 * @returns the name with non-identifier characters replaced by `_`, prefixed
 *   with `_` when it would otherwise start with a digit.
 */
export function safeIdentifier(name: string): string {
  const normalized = name.replace(/[^$\w]/gu, '_')
  if (/^[$A-Z_a-z]/u.test(normalized)) return normalized
  return `_${normalized}`
}

/**
 * Quote one value as a single-quoted JavaScript string literal.
 * @param value - raw text.
 * @returns the quoted literal, with backslashes, quotes, and newlines escaped.
 */
export function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

/**
 * Indent every physical line of a multi-line artifact.
 * @param value - text to indent.
 * @param spaces - number of leading spaces per line.
 * @returns the indented text.
 */
export function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map(line => `${prefix}${line}`).join('\n')
}

/**
 * Allocate one unused name from a base, suffixing numerically on collision.
 * @param base - preferred name.
 * @param used - names already taken; the result is added to it.
 * @returns `base`, or `base` followed by the first free number from 2.
 */
export function uniqueName(base: string, used: Set<string>): string {
  let name = base
  let suffix = 2
  while (used.has(name)) name = `${base}${String(suffix++)}`
  used.add(name)
  return name
}
