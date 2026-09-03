import { createHash } from 'node:crypto'

export const INTEGRATION_CONTROL_FILE = 'dsh-integration-release.bao'
export const INTEGRATION_PACK_FILE = 'dsh-integration-release.pack'
export const INTEGRATION_RELEASE_SCHEMA = 'deepseek-harness.integration-release/v1'

const DIGEST = /^[a-f0-9]{64}$/u
const GIT_IDENTITY = /^[a-f0-9]{40}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u
const SAFE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))(?!.*\\)[A-Za-z0-9@._/+~-]+$/u
const CONTROL_KEYS = JSON.stringify(['pack', 'packages', 'runtime', 'schema', 'source'])
const SOURCE_KEYS = JSON.stringify(['commit', 'tree'])
const RUNTIME_KEYS = JSON.stringify(['entry', 'node', 'packageManager', 'platform', 'toolPackage'])
const ENTRY_KEYS = JSON.stringify(['name', 'package', 'path', 'version'])
const NODE_KEYS = JSON.stringify(['engine', 'minimumExactMajor', 'minimumExactMinor', 'minimumMajor'])
const PACKAGE_KEYS = JSON.stringify(['byteSize', 'cpu', 'family', 'file', 'name', 'os', 'sha256', 'version'])
const PACK_KEYS = JSON.stringify(['byteSize', 'entries', 'file', 'sha256'])
const PACK_ENTRY_KEYS = JSON.stringify(['byteSize', 'mode', 'offset', 'path', 'sha256'])
const PLATFORMS = /^(?:aix|android|darwin|freebsd|linux|openbsd|sunos|win32|x64|arm64|arm|ia32|ppc64|s390x|riscv64)$/u

export type IntegrationFamily = 'dsh' | 'native' | 'vendor'

const FAMILIES: ReadonlySet<IntegrationFamily> = new Set(['dsh', 'native', 'vendor'])

export interface IntegrationPackageInput {
  readonly cpu: readonly string[]
  readonly family: IntegrationFamily
  readonly file: string
  readonly name: string
  readonly os: readonly string[]
  readonly version: string
}

export interface IntegrationFileInput {
  readonly bytes: Uint8Array
  readonly path: string
}

export interface IntegrationRuntimeInput {
  readonly engine: string
  readonly entry: {
    readonly name: string
    readonly package: string
    readonly path: string
    readonly version: string
  }
  readonly minimumExactMajor: number
  readonly minimumExactMinor: number
  readonly minimumMajor: number
  readonly packageManager: string
  readonly platform: string
  readonly toolPackage: string
}

export interface IntegrationReleaseInput {
  readonly files: readonly IntegrationFileInput[]
  readonly packages: readonly IntegrationPackageInput[]
  readonly runtime: IntegrationRuntimeInput
  readonly source: {
    readonly commit: string
    readonly tree: string
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: unknown, keys: string): value is Record<string, unknown> {
  return record(value) && JSON.stringify(Object.keys(value).sort()) === keys
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (!record(value)) return value
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map(key => [key, canonicalValue(value[key])]),
  )
}

function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(canonicalValue(value), null, 2)}\n`)
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function requireSafePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_PATH.test(value) || value.includes('//')) {
    throw new Error(`${label} path is invalid`)
  }
  return value
}

function requirePackageName(value: unknown): string {
  if (typeof value !== 'string' || !PACKAGE_NAME.test(value)) {
    throw new Error('integration release package name is invalid')
  }
  return value
}

function requireVersion(value: unknown): string {
  if (typeof value !== 'string' || !VERSION.test(value)) {
    throw new Error('integration release package version is invalid')
  }
  return value
}

function requirePositiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`integration release ${label} is invalid`)
  }
  return value
}

function requireFamily(value: unknown): IntegrationFamily {
  if (value !== 'dsh' && value !== 'native' && value !== 'vendor') {
    throw new Error('integration release package family is invalid')
  }
  return value
}

function validatePlatformList(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`integration release package ${label} is invalid`)
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || !PLATFORMS.test(entry)) {
      throw new Error(`integration release package ${label} is invalid`)
    }
    entries.push(entry)
  }
  if (new Set(entries).size !== entries.length || JSON.stringify(entries) !== JSON.stringify([...entries].sort())) {
    throw new Error(`integration release package ${label} is not canonical`)
  }
  return entries
}

function validatePackEntry(value: unknown) {
  if (
    !exactKeys(value, PACK_ENTRY_KEYS) ||
    value.mode !== '0444' ||
    typeof value.sha256 !== 'string' ||
    !DIGEST.test(value.sha256)
  ) {
    throw new Error('integration release pack entry is invalid')
  }
  requireSafePath(value.path, 'integration release pack entry')
  requirePositiveInteger(value.byteSize, 'pack entry byte size')
  if (typeof value.offset !== 'number' || !Number.isSafeInteger(value.offset) || value.offset < 0) {
    throw new Error('integration release pack entry offset is invalid')
  }
  return {
    byteSize: requirePositiveInteger(value.byteSize, 'pack entry byte size'),
    mode: value.mode,
    offset: value.offset,
    path: requireSafePath(value.path, 'integration release pack entry'),
    sha256: value.sha256,
  }
}

function validatePackage(value: unknown) {
  if (
    !exactKeys(value, PACKAGE_KEYS) ||
    typeof value.family !== 'string' ||
    typeof value.sha256 !== 'string' ||
    !DIGEST.test(value.sha256)
  ) {
    throw new Error('integration release package record is invalid')
  }
  requirePackageName(value.name)
  requireVersion(value.version)
  const file = requireSafePath(value.file, 'integration release package')
  if (!file.startsWith('packages/') || !file.endsWith('.tgz')) {
    throw new Error('integration release package file is invalid')
  }
  requirePositiveInteger(value.byteSize, 'package byte size')
  return {
    byteSize: requirePositiveInteger(value.byteSize, 'package byte size'),
    cpu: validatePlatformList(value.cpu, 'CPU list'),
    family: requireFamily(value.family),
    file,
    name: requirePackageName(value.name),
    os: validatePlatformList(value.os, 'OS list'),
    sha256: value.sha256,
    version: requireVersion(value.version),
  }
}

function validateRuntime(value: unknown) {
  if (!exactKeys(value, RUNTIME_KEYS) || !exactKeys(value.entry, ENTRY_KEYS) || !exactKeys(value.node, NODE_KEYS)) {
    throw new Error('integration release runtime contract is invalid')
  }
  requirePackageName(value.entry.name)
  requirePackageName(value.entry.package)
  requireVersion(value.entry.version)
  if (value.entry.name !== 'dsh' || value.entry.path !== 'lib/bin.js') {
    throw new Error('integration release executable identity is invalid')
  }
  if (
    typeof value.node.engine !== 'string' ||
    value.node.engine.length === 0 ||
    typeof value.node.minimumExactMajor !== 'number' ||
    !Number.isSafeInteger(value.node.minimumExactMajor) ||
    typeof value.node.minimumExactMinor !== 'number' ||
    !Number.isSafeInteger(value.node.minimumExactMinor) ||
    typeof value.node.minimumMajor !== 'number' ||
    !Number.isSafeInteger(value.node.minimumMajor) ||
    value.node.minimumExactMajor < 1 ||
    value.node.minimumExactMinor < 0 ||
    value.node.minimumMajor <= value.node.minimumExactMajor
  ) {
    throw new Error('integration release Node contract is invalid')
  }
  if (
    typeof value.packageManager !== 'string' ||
    !/^bun@[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.packageManager) ||
    typeof value.platform !== 'string' ||
    !/^[a-z0-9]+-[a-z0-9]+$/u.test(value.platform)
  ) {
    throw new Error('integration release runtime platform is invalid')
  }
  requirePackageName(value.toolPackage)
  if (value.toolPackage !== '@deepseek-ai/dsh-tool-shell') {
    throw new Error('integration release shell tool identity is invalid')
  }
  const expectedEngine = `^${String(value.node.minimumExactMajor)}.${String(value.node.minimumExactMinor)}.0 || >=${String(value.node.minimumMajor)}.0.0`
  if (value.node.engine !== expectedEngine) throw new Error('integration release Node engine differs from its rules')
  return {
    entry: {
      name: value.entry.name,
      package: requirePackageName(value.entry.package),
      path: value.entry.path,
      version: requireVersion(value.entry.version),
    },
    node: {
      engine: value.node.engine,
      minimumExactMajor: value.node.minimumExactMajor,
      minimumExactMinor: value.node.minimumExactMinor,
      minimumMajor: value.node.minimumMajor,
    },
    packageManager: value.packageManager,
    platform: value.platform,
    toolPackage: requirePackageName(value.toolPackage),
  }
}

export function validateIntegrationReleaseControl(value: unknown) {
  if (
    !exactKeys(value, CONTROL_KEYS) ||
    value.schema !== INTEGRATION_RELEASE_SCHEMA ||
    !exactKeys(value.source, SOURCE_KEYS) ||
    typeof value.source.commit !== 'string' ||
    !GIT_IDENTITY.test(value.source.commit) ||
    typeof value.source.tree !== 'string' ||
    !GIT_IDENTITY.test(value.source.tree) ||
    !Array.isArray(value.packages) ||
    value.packages.length < 3 ||
    !exactKeys(value.pack, PACK_KEYS) ||
    value.pack.file !== INTEGRATION_PACK_FILE ||
    typeof value.pack.sha256 !== 'string' ||
    !DIGEST.test(value.pack.sha256) ||
    !Array.isArray(value.pack.entries) ||
    value.pack.entries.length < 3
  ) {
    throw new Error('integration release control is invalid')
  }
  const runtime = validateRuntime(value.runtime)
  const packages = value.packages.map(validatePackage)
  const packageNames = packages.map(entry => entry.name)
  const packageFiles = packages.map(entry => entry.file)
  if (
    new Set(packageNames).size !== packageNames.length ||
    new Set(packageFiles).size !== packageFiles.length ||
    JSON.stringify(packageNames) !== JSON.stringify([...packageNames].sort()) ||
    ![...FAMILIES].every(family => packages.some(entry => entry.family === family))
  ) {
    throw new Error('integration release package inventory is invalid')
  }
  const dshVersions = new Set(packages.filter(entry => entry.family === 'dsh').map(entry => entry.version))
  if (
    dshVersions.size !== 1 ||
    !packages.some(
      entry => entry.name === runtime.entry.package && entry.version === runtime.entry.version && entry.family === 'dsh',
    ) ||
    !packages.some(entry => entry.name === runtime.toolPackage && entry.family === 'dsh')
  ) {
    throw new Error('integration release DSH identity is invalid')
  }
  const entries = value.pack.entries.map(validatePackEntry)
  const paths = entries.map(entry => entry.path)
  if (new Set(paths).size !== paths.length || JSON.stringify(paths) !== JSON.stringify([...paths].sort())) {
    throw new Error('integration release pack inventory is invalid')
  }
  let offset = 0
  for (const entry of entries) {
    if (entry.offset !== offset) throw new Error('integration release pack ranges are not contiguous')
    offset += entry.byteSize
    if (!Number.isSafeInteger(offset)) throw new Error('integration release pack range is invalid')
  }
  if (typeof value.pack.byteSize !== 'number' || value.pack.byteSize !== offset) {
    throw new Error('integration release pack size differs')
  }
  for (const entry of packages) {
    const packed = entries.find(candidate => candidate.path === entry.file)
    if (
      packed === undefined ||
      packed.byteSize !== entry.byteSize ||
      packed.sha256 !== entry.sha256
    ) {
      throw new Error('integration release package differs from its pack entry')
    }
  }
  for (const required of ['bun.lock', 'package.json']) {
    if (!paths.includes(required)) throw new Error(`integration release pack lacks ${required}`)
  }
  if (paths.length !== packages.length + 2) {
    throw new Error('integration release pack contains unbound members')
  }
  return {
    pack: {
      byteSize: value.pack.byteSize,
      entries,
      file: value.pack.file,
      sha256: value.pack.sha256,
    },
    packages,
    runtime,
    schema: value.schema,
    source: {
      commit: value.source.commit,
      tree: value.source.tree,
    },
  }
}

export function parseIntegrationReleaseControl(bytes: Uint8Array) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > 16 * 1024 * 1024) {
    throw new Error('integration release control bytes are invalid')
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  const value: unknown = JSON.parse(text)
  const control = validateIntegrationReleaseControl(value)
  if (!canonicalBytes(control).equals(Buffer.from(bytes))) {
    throw new Error('integration release control is not canonical')
  }
  return control
}

export function integrationReleaseFiles(
  controlValue: unknown,
  packBytes: Uint8Array,
): ReadonlyMap<string, Buffer> {
  const control = validateIntegrationReleaseControl(controlValue)
  if (
    !(packBytes instanceof Uint8Array) ||
    packBytes.byteLength !== control.pack.byteSize ||
    digest(packBytes) !== control.pack.sha256
  ) {
    throw new Error('integration release pack identity differs')
  }
  const files = new Map<string, Buffer>()
  for (const entry of control.pack.entries) {
    const start = entry.offset
    const end = start + entry.byteSize
    const bytes = Buffer.from(packBytes.subarray(start, end))
    if (digest(bytes) !== entry.sha256) throw new Error(`integration release member differs: ${entry.path}`)
    files.set(entry.path, bytes)
  }
  return files
}

export function createIntegrationRelease(input: IntegrationReleaseInput): {
  readonly control: Record<string, unknown>
  readonly controlBytes: Buffer
  readonly packBytes: Buffer
} {
  const files = [...input.files].sort((left, right) => left.path.localeCompare(right.path))
  if (files.length < 3 || new Set(files.map(entry => entry.path)).size !== files.length) {
    throw new Error('integration release source files are invalid')
  }
  let offset = 0
  const entries = files.map((entry) => {
    requireSafePath(entry.path, 'integration release source')
    if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength < 1) {
      throw new Error('integration release source bytes are invalid')
    }
    const record = {
      byteSize: entry.bytes.byteLength,
      mode: '0444',
      offset,
      path: entry.path,
      sha256: digest(entry.bytes),
    }
    offset += entry.bytes.byteLength
    return record
  })
  const packBytes = Buffer.concat(files.map(entry => Buffer.from(entry.bytes)))
  const byPath = new Map(entries.map(entry => [entry.path, entry]))
  const packages = [...input.packages]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => {
      const packed = byPath.get(entry.file)
      if (packed === undefined) throw new Error(`integration release package file is absent: ${entry.file}`)
      return {
        byteSize: packed.byteSize,
        cpu: [...entry.cpu].sort(),
        family: entry.family,
        file: entry.file,
        name: entry.name,
        os: [...entry.os].sort(),
        sha256: packed.sha256,
        version: entry.version,
      }
    })
  const control = validateIntegrationReleaseControl({
    pack: {
      byteSize: packBytes.byteLength,
      entries,
      file: INTEGRATION_PACK_FILE,
      sha256: digest(packBytes),
    },
    packages,
    runtime: {
      entry: input.runtime.entry,
      node: {
        engine: input.runtime.engine,
        minimumExactMajor: input.runtime.minimumExactMajor,
        minimumExactMinor: input.runtime.minimumExactMinor,
        minimumMajor: input.runtime.minimumMajor,
      },
      packageManager: input.runtime.packageManager,
      platform: input.runtime.platform,
      toolPackage: input.runtime.toolPackage,
    },
    schema: INTEGRATION_RELEASE_SCHEMA,
    source: input.source,
  })
  return { control, controlBytes: canonicalBytes(control), packBytes }
}
