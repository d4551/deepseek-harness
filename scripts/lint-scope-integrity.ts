/** Complete configuration and discovery inputs reviewed for repository lint. */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, posix } from 'node:path'
import { parseConfigFileTextToJson, type JsonValue } from './ts7-session.ts'

const REVIEWED_SCOPE_SHA256 = '151f1c61209117d04ec2358db43e4f1691ba91b0fa36d909bcbabc408b10bc01'
const CONFIG_FILES = ['.oxlintrc.json', '.oxlintrc.staged.json']
const DISCOVERY_FILES = ['.gitignore', 'website/.gitignore', 'native/landlock-run/.gitignore', '.agents/skills/.gitignore']
const SCOPE_FILE_NAMES = [
  '.gitignore', '.eslintignore', '.oxlintrc.json',
  'oxlint.config.ts', 'oxlint.config.js', 'oxlint.config.mjs', 'oxlint.config.cjs', 'oxlint.config.mts', 'oxlint.config.cts',
]

function additionalScopeFiles(root: string): JsonValue {
  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' })
  const directories = new Set(['.'])
  for (const file of files.split('\0')) {
    if (file === '') continue
    for (let directory = posix.dirname(file); directory !== '.'; directory = posix.dirname(directory)) {
      directories.add(directory)
    }
  }
  const known = new Set([...CONFIG_FILES, ...DISCOVERY_FILES, '.eslintignore'])
  const additional: Record<string, JsonValue> = {}
  for (const directory of directories) {
    for (const name of SCOPE_FILE_NAMES) {
      const file = posix.join(directory, name)
      if (known.has(file) || !existsSync(join(root, file))) continue
      additional[file] = readFileSync(join(root, file), 'utf8')
    }
  }
  return additional
}

function readConfiguration(path: string): JsonValue {
  const result = parseConfigFileTextToJson(readFileSync(path, 'utf8'))
  if (result.error !== undefined) throw new Error(result.error.messageText)
  if (result.config === undefined) throw new Error(`lint scope configuration is empty: ${path}`)
  return result.config
}

/**
 * Read both lint profiles and the repository discovery exclusions without changing their scope.
 * @param root - repository root.
 * @returns the complete reviewed scope value.
 */
export function readLintScope(root: string): JsonValue {
  return {
    configurations: Object.fromEntries(CONFIG_FILES.map(file => [file, readConfiguration(join(root, file))])),
    discovery: Object.fromEntries(DISCOVERY_FILES.map(file => [file, readFileSync(join(root, file), 'utf8')])),
    eslintIgnore: existsSync(join(root, '.eslintignore')) ? readFileSync(join(root, '.eslintignore'), 'utf8') : null,
    additionalScopeFiles: additionalScopeFiles(root),
  }
}

function ordered(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(ordered)
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const entry = value[key]
    if (entry === undefined) throw new Error(`lint scope field is undefined: ${key}`)
    return [key, ordered(entry)]
  }))
}

/**
 * Reject changes to reviewed lint rules, options, matchers, plugins, or discovery exclusions.
 * @param scope - complete configuration and discovery value.
 */
export function assertLintScopeIntegrity(scope: JsonValue): void {
  const digest = createHash('sha256').update(JSON.stringify(ordered(scope))).digest('hex')
  if (digest !== REVIEWED_SCOPE_SHA256) throw new Error(`lint scope differs from the reviewed configuration: ${digest}`)
}
