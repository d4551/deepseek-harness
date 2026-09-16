/** Path-segment validation shared by record writes and whole-unit import. */

/** Record key characters accepted on each supported filesystem. */
export const SAFE_KEY_RE = /^[a-zA-Z0-9_-]+$/

/**
 * Reject a record key before it can name a path outside its table.
 * @param unit - Unit name identifying the rejected operation in its diagnostic.
 * @param key - Record key that must consist only of permitted path-segment characters.
 */
export function assertSafeKey(unit: string, key: string): void {
  if (!SAFE_KEY_RE.test(key)) {
    throw new Error(`unit '${unit}': per-record key '${key}' is not path-safe (must match ${SAFE_KEY_RE})`)
  }
}
