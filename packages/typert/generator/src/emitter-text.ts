/**
 * Shared text helpers for the Typert emitters: identifier normalization,
 * string literal quoting, and block indentation.
 */

/** Turn one exported or wire name into a valid JavaScript identifier. */
export function safeIdentifier(name: string): string {
  const normalized = name.replace(/[^$\w]/gu, '_')
  if (/^[$A-Z_a-z]/u.test(normalized)) return normalized
  return `_${normalized}`
}

/** Quote one value as a single-quoted JavaScript string literal. */
export function quote(value: string): string {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`
}

/** Indent every physical line of a multi-line artifact. */
export function indent(value: string, spaces: number): string {
  const prefix = ' '.repeat(spaces)
  return value.split('\n').map(line => `${prefix}${line}`).join('\n')
}
