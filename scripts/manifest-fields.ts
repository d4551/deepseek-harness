/**
 * Typed reads over a parsed package manifest. The verifiers that compare
 * manifests against the workspace share these so one definition decides what
 * counts as a declared dependency range.
 */

/**
 * Read one manifest field that must map names to string ranges.
 * @param record - parsed manifest object.
 * @param key - field to read.
 * @returns the string-valued entries, empty when the field is absent or not an object.
 */
export function optionalStringRecord(record: object, key: string): Record<string, string> {
  if (!Object.hasOwn(record, key)) return {}
  const value: unknown = Reflect.get(record, key)
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  const out: Record<string, string> = {}
  for (const [name, range] of Object.entries(value)) {
    if (typeof range === 'string') out[name] = range
  }
  return out
}
