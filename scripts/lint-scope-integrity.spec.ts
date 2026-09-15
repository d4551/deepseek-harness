import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { assertLintScopeIntegrity, readLintScope } from './lint-scope-integrity.ts'
import type { JsonValue } from './ts7-session.ts'

function object(value: JsonValue | undefined): { [key: string]: JsonValue | undefined } {
  if (value === undefined || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('expected a lint configuration object')
  }
  return value
}

function array(value: JsonValue | undefined): JsonValue[] {
  if (!Array.isArray(value)) throw new Error('expected a lint configuration array')
  return value
}

const root = fileURLToPath(new URL('..', import.meta.url))
const reviewed = readLintScope(root)
const directories: string[] = []

afterAll(async () => {
  await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true })))
})

function changedRoot(change: (config: { [key: string]: JsonValue | undefined }) => void): JsonValue {
  const scope = structuredClone(reviewed)
  change(object(object(object(scope).configurations)['.oxlintrc.json']))
  return scope
}

describe('complete lint scope integrity', () => {
  it('accepts the exact repository configuration and discovery inputs', () => {
    expect(() => { assertLintScopeIntegrity(reviewed) }).not.toThrow()
  })

  it.each(['files', 'plugins', 'jsPlugins'])('rejects changing every override %s field', (field) => {
    const overrides = array(object(object(object(reviewed).configurations)['.oxlintrc.json']).overrides)
    expect(overrides).toHaveLength(9)
    for (const index of overrides.keys()) {
      const changed = changedRoot((config) => {
        object(array(config.overrides)[index])[field] = []
      })
      expect(() => { assertLintScopeIntegrity(changed) }, `override ${String(index)} ${field}`)
        .toThrow('lint scope differs')
    }
  })

  it('rejects narrowing a file matcher while retaining every rule', () => {
    const changed = changedRoot((config) => {
      object(array(config.overrides)[0]).files = ['scripts/limited.ts']
    })
    const original = object(object(object(reviewed).configurations)['.oxlintrc.json'])
    const modified = object(object(object(changed).configurations)['.oxlintrc.json'])
    expect(array(modified.overrides).map(value => object(value).rules))
      .toEqual(array(original.overrides).map(value => object(value).rules))
    expect(() => { assertLintScopeIntegrity(changed) }).toThrow('lint scope differs')
  })

  it.each([
    ['ignorePatterns', ['**/*']],
    ['plugins', ['typescript']],
    ['categories', { correctness: 'allow', restriction: 'allow' }],
    ['options', { typeAware: false }],
    ['env', {}],
    ['extends', ['./scope-reduction.json']],
    ['rules', { 'no-void': 'off' }],
  ] satisfies Array<[string, JsonValue]>)('rejects changing root %s', (field, value) => {
    const changed = changedRoot((config) => { config[field] = value })
    expect(() => { assertLintScopeIntegrity(changed) }).toThrow('lint scope differs')
  })

  it('rejects removal or reordering of overrides', () => {
    for (const reorder of [false, true]) {
      const changed = changedRoot((config) => {
        const overrides = array(config.overrides)
        if (reorder) overrides.reverse()
        else overrides.pop()
      })
      expect(() => { assertLintScopeIntegrity(changed) }).toThrow('lint scope differs')
    }
  })

  it('rejects additional staged exclusions', () => {
    const changed = structuredClone(reviewed)
    const staged = object(object(object(changed).configurations)['.oxlintrc.staged.json'])
    staged.ignorePatterns = ['**/*']
    expect(() => { assertLintScopeIntegrity(changed) }).toThrow('lint scope differs')
  })

  it('rejects changes to every discovery exclusion file', () => {
    for (const file of Object.keys(object(object(reviewed).discovery))) {
      const changed = structuredClone(reviewed)
      object(object(changed).discovery)[file] = '*\n'
      expect(() => { assertLintScopeIntegrity(changed) }, file).toThrow('lint scope differs')
    }
  })

  it('rejects adding an ESLint exclusion file', () => {
    const changed = structuredClone(reviewed)
    object(changed).eslintIgnore = '*\n'
    expect(() => { assertLintScopeIntegrity(changed) }).toThrow('lint scope differs')
  })

  it('rejects real configuration and exclusion files introduced on disk', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-lint-scope-'))
    directories.push(directory)
    execFileSync('git', ['init', '--quiet', directory])
    const scope = object(reviewed)
    for (const [file, value] of Object.entries(object(scope.configurations))) {
      if (value === undefined) throw new Error('configuration value is missing')
      await writeFile(join(directory, file), JSON.stringify(value))
    }
    for (const [file, value] of Object.entries(object(scope.discovery))) {
      if (typeof value !== 'string') throw new Error('discovery file must contain text')
      await mkdir(dirname(join(directory, file)), { recursive: true })
      await writeFile(join(directory, file), value)
    }
    await mkdir(join(directory, 'scripts'), { recursive: true })
    await writeFile(join(directory, 'scripts/source.ts'), 'export const value = 1\n')
    execFileSync('git', ['add', '--', 'scripts/source.ts'], { cwd: directory })
    expect(() => { assertLintScopeIntegrity(readLintScope(directory)) }).not.toThrow()

    await writeFile(join(directory, 'scripts/.gitignore'), '*\n')
    expect(() => { assertLintScopeIntegrity(readLintScope(directory)) }).toThrow('lint scope differs')
    await rm(join(directory, 'scripts/.gitignore'))
    await writeFile(join(directory, 'scripts/.oxlintrc.json'), '{"ignorePatterns":["**/*"]}\n')
    expect(() => { assertLintScopeIntegrity(readLintScope(directory)) }).toThrow('lint scope differs')
    await rm(join(directory, 'scripts/.oxlintrc.json'))
    expect(() => { assertLintScopeIntegrity(readLintScope(directory)) }).not.toThrow()

    await writeFile(join(directory, '.eslintignore'), '*\n')
    expect(() => { assertLintScopeIntegrity(readLintScope(directory)) }).toThrow('lint scope differs')
    await rm(join(directory, '.eslintignore'))
    expect(() => { assertLintScopeIntegrity(readLintScope(directory)) }).not.toThrow()

    const narrowed = structuredClone(object(object(scope.configurations)['.oxlintrc.json']))
    narrowed.ignorePatterns = ['**/*']
    await writeFile(join(directory, '.oxlintrc.json'), JSON.stringify(narrowed))
    expect(() => { assertLintScopeIntegrity(readLintScope(directory)) }).toThrow('lint scope differs')
  })
})
