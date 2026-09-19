import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parseConfigFileTextToJson } from './ts7-session.ts'
import { assertLintScopeIntegrity, readLintScope } from './lint-scope-integrity.ts'

type Rules = Record<string, unknown>

interface Profile {
  readonly count: number
  readonly indexes: readonly number[]
  readonly sha256: string
}

// A one-time audit against eslint.config.mjs blob 696b08282885296830189fdafe7051a356806fc2
// mapped @typescript-eslint/* to typescript/* and four extension rules to their
// Oxlint core equivalents. These fingerprints pin the resulting repository
// snapshot; they do not re-evaluate that deleted baseline or track its preset.
// The counts dropped by the eight `sonarjs/*` rules the TypeScript 7 lint
// toolchain cannot load; the Agent Note names their replacement coverage.
// Commit 79711728bcfe9a8a084f4af246612ec0652490fb enabled no-void in all
// three profiles.
const profiles = {
  source: {
    count: 119,
    indexes: [0, 1, 2, 5, 6],
    sha256: '1f718ebbc0ab28bdd8150659c4e895e2ee80e8e27edd0a9f58c06b6b6047999c',
  },
  example: {
    count: 81,
    indexes: [0, 1, 3, 5, 6],
    sha256: '884873518a8dcfc6709a760174f13496487845bd61131cb8389df87f961d2c9e',
  },
  test: {
    count: 114,
    indexes: [0, 2, 4, 5, 6],
    sha256: '86ea9116cbfed73ff2e876ea1050f0f04445594e35f9c298975a49cefd727fec',
  },
} as const satisfies Record<string, Profile>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value)
}

function severity(value: unknown): 0 | 1 | 2 {
  const level = isUnknownArray(value) ? value[0] : value
  if (level === 'off' || level === 0) return 0
  if (level === 'warn' || level === 'warning' || level === 1) return 1
  if (level === 'error' || level === 2) return 2
  throw new Error(`unsupported lint severity: ${JSON.stringify(level)}`)
}

function normalizedRules(rules: Rules): Rules {
  return Object.fromEntries(Object.entries(rules)
    .filter(([, value]) => severity(value) > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      const options = isUnknownArray(value) ? value.slice(1) : []
      return [name, [severity(value), ...options]]
    }))
}

function mergedRules(overrides: readonly unknown[], indexes: readonly number[]): Rules {
  const merged: Rules = {}
  for (const index of indexes) {
    const override = overrides[index]
    if (!isRecord(override) || !isRecord(override.rules)) {
      throw new Error(`.oxlintrc.json override ${index} must contain a rules object`)
    }
    Object.assign(merged, override.rules)
  }
  return normalizedRules(merged)
}

describe('Oxlint repository rule fingerprint', () => {
  const path = fileURLToPath(new URL('../.oxlintrc.json', import.meta.url))
  const result = parseConfigFileTextToJson(readFileSync(path, 'utf8'))
  if (result.error !== undefined) {
    throw new Error(result.error.messageText)
  }
  const parsed: unknown = result.config
  if (!isRecord(parsed) || !Array.isArray(parsed.overrides)) {
    throw new Error('.oxlintrc.json must contain an overrides array')
  }
  const overrides: readonly unknown[] = parsed.overrides

  it('pins every override field', () => {
    expect(overrides).toHaveLength(10)
    assertLintScopeIntegrity(readLintScope(fileURLToPath(new URL('..', import.meta.url))))
  })

  it.each(Object.entries(profiles))('pins the %s rule profile', (_name, profile) => {
    const rules = mergedRules(overrides, profile.indexes)
    const fingerprint = createHash('sha256').update(JSON.stringify(rules)).digest('hex')

    expect(Object.keys(rules)).toHaveLength(profile.count)
    expect(fingerprint).toBe(profile.sha256)
    expect(rules['no-void']).toEqual([2])
    expect(rules['typescript/use-unknown-in-catch-callback-variable']).toBeUndefined()
  })
})
