import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import {
  createIntegrationRelease,
  INTEGRATION_CONTROL_FILE,
  INTEGRATION_PACK_FILE,
  type IntegrationFamily,
  type IntegrationPackageInput,
} from './integration-release-contract.ts'
import { packFamily } from './pack.ts'
import { attempt, capture, isEntry, runConcurrent } from './process.ts'
import { readPublishOrder } from './tarball.ts'

const DEFAULT_OUTPUT = 'dist/integration'
const NATIVE_ROOT = 'native/landlock-run'
const NATIVE_ENTRY = '@deepseek-ai/node-addon-landlock-run'
const DSH_ENTRY = '@deepseek-ai/dsh'
const SHELL_TOOL = '@deepseek-ai/dsh-tool-shell'
const RELEASE_STATUS_PATHS = [
  ':(top)**',
  ':(top,exclude).agents/**',
  ':(top,exclude)goal/**',
] as const

interface RootManifest {
  readonly engine: string
  readonly packageManager: string
}

interface PackedPackage extends IntegrationPackageInput {
  readonly bytes: Buffer
  readonly bin: ReadonlyMap<string, string>
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function sortedStrings(value: unknown, label: string): readonly string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
  const entries: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) throw new Error(`${label} has an invalid member`)
    entries.push(entry)
  }
  return [...entries].sort()
}

function packageBin(value: unknown, label: string): ReadonlyMap<string, string> {
  if (value === undefined) return new Map()
  if (typeof value === 'string' && value.length > 0) {
    const name = label.split('/').at(-1)
    if (name === undefined || name.length === 0) throw new Error(`${label} bin name is invalid`)
    return new Map([[name, value]])
  }
  if (!record(value)) throw new Error(`${label} bin is invalid`)
  const entries = new Map<string, string>()
  for (const [name, path] of Object.entries(value)) {
    if (typeof path !== 'string') throw new Error(`${label} bin path is invalid`)
    entries.set(name, path)
  }
  return entries
}

function readRootManifest(root: string): RootManifest {
  const value: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (
    !record(value) ||
    typeof value.packageManager !== 'string' ||
    !record(value.engines) ||
    typeof value.engines.node !== 'string'
  ) {
    throw new Error('root package manifest lacks packageManager or engines.node')
  }
  return { engine: value.engines.node, packageManager: value.packageManager }
}

function readPackedPackage(family: IntegrationFamily, directory: string, filename: string): PackedPackage {
  if (basename(filename) !== filename || !filename.endsWith('.tgz')) {
    throw new Error(`release pack lists an invalid tarball: ${filename}`)
  }
  const tarball = join(directory, filename)
  const value: unknown = JSON.parse(capture('tar', ['-xOzf', tarball, 'package/package.json']))
  if (!record(value) || typeof value.name !== 'string' || typeof value.version !== 'string') {
    throw new Error(`${filename} manifest lacks package identity`)
  }
  return {
    bin: packageBin(value.bin, value.name),
    bytes: readFileSync(tarball),
    cpu: sortedStrings(value.cpu, `${value.name} cpu`),
    family,
    file: `packages/${filename}`,
    name: value.name,
    os: sortedStrings(value.os, `${value.name} os`),
    version: value.version,
  }
}

function readFamily(family: IntegrationFamily, directory: string): readonly PackedPackage[] {
  return readPublishOrder(directory).map(filename => readPackedPackage(family, directory, filename))
}

function sourceIdentity(root: string): { readonly commit: string; readonly tree: string } {
  const status = capture(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all', '--', ...RELEASE_STATUS_PATHS],
    { cwd: root },
  )
  if (status !== '') throw new Error(`integration release requires a clean source tree:\n${status}`)
  return {
    commit: capture('git', ['rev-parse', 'HEAD'], { cwd: root }),
    tree: capture('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }),
  }
}

function nodeRules(engine: string): {
  readonly minimumExactMajor: number
  readonly minimumExactMinor: number
  readonly minimumMajor: number
} {
  const match = /^\^(\d+)\.(\d+)\.0 \|\| >=(\d+)\.0\.0$/u.exec(engine)
  if (match === null) throw new Error(`unsupported Node engine contract: ${engine}`)
  const exactMajor = Number(match[1])
  const exactMinor = Number(match[2])
  const minimumMajor = Number(match[3])
  if (!Number.isSafeInteger(exactMajor) || !Number.isSafeInteger(exactMinor) || !Number.isSafeInteger(minimumMajor)) {
    throw new Error(`invalid Node engine contract: ${engine}`)
  }
  return { minimumExactMajor: exactMajor, minimumExactMinor: exactMinor, minimumMajor }
}

function verifyPackages(packages: readonly PackedPackage[]): PackedPackage {
  const names = packages.map(entry => entry.name)
  const files = packages.map(entry => entry.file)
  if (new Set(names).size !== names.length || new Set(files).size !== files.length) {
    throw new Error('release families contain duplicate package identities')
  }
  const entry = packages.find(candidate => candidate.name === DSH_ENTRY)
  if (entry === undefined || entry.bin.size !== 1 || entry.bin.get('dsh') !== 'lib/bin.js') {
    throw new Error('DSH package must expose only dsh at lib/bin.js')
  }
  if (!packages.some(candidate => candidate.name === SHELL_TOOL && candidate.family === 'dsh')) {
    throw new Error('DSH release lacks the shell tool package')
  }
  const nativeEntry = packages.find(candidate => candidate.name === NATIVE_ENTRY && candidate.family === 'native')
  if (nativeEntry === undefined) throw new Error('native release lacks its entry package')
  const nativePlatform = packages.filter(
    candidate => candidate.family === 'native' && candidate.os.includes(process.platform) && candidate.cpu.includes(process.arch),
  )
  const expectedNativePlatforms = process.platform === 'linux' ? 1 : 0
  if (nativePlatform.length !== expectedNativePlatforms) {
    throw new Error(`native release does not match ${process.platform}-${process.arch}`)
  }
  return entry
}

function runtimeManifest(packages: readonly PackedPackage[], rootManifest: RootManifest, version: string): Buffer {
  const fileDependencies = Object.fromEntries(
    [...packages]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map(entry => [entry.name, `file:./${entry.file}`]),
  )
  return Buffer.from(`${JSON.stringify({
    dependencies: fileDependencies,
    engines: { node: rootManifest.engine },
    name: 'dsh-integrated-runtime',
    overrides: fileDependencies,
    packageManager: rootManifest.packageManager,
    private: true,
    type: 'module',
    version,
  }, null, 2)}\n`)
}

function createLock(root: string, directory: string, manifest: Buffer, packages: readonly PackedPackage[]): Buffer {
  writeFileSync(join(directory, 'package.json'), manifest, { flag: 'wx' })
  const packageDirectory = join(directory, 'packages')
  mkdirSync(packageDirectory)
  for (const entry of packages) {
    const target = join(packageDirectory, basename(entry.file))
    writeFileSync(target, entry.bytes, { flag: 'wx' })
  }
  const result = attempt('bun', [
    'install',
    '--lockfile-only',
    '--save-text-lockfile',
    '--ignore-scripts',
    '--backend=copyfile',
    '--no-progress',
  ], { cwd: directory })
  if (result.status !== 0) {
    throw new Error(`integration lock generation failed:\n${result.stdout}\n${result.stderr}`)
  }
  const lockPath = join(directory, 'bun.lock')
  if (!existsSync(lockPath)) throw new Error('integration lock generation produced no bun.lock')
  const lock = readFileSync(lockPath)
  const text = lock.toString('utf8')
  if (text.includes('workspace:') || text.includes(root) || text.includes(directory)) {
    throw new Error('integration lock is not relocatable')
  }
  return lock
}

function prepareOutput(output: string): void {
  if (existsSync(output)) {
    const entries = readdirSync(output)
    if (entries.length !== 0) throw new Error(`integration release output is not empty: ${output}`)
    return
  }
  mkdirSync(output, { recursive: true })
}

export async function packIntegration(outputValue = DEFAULT_OUTPUT): Promise<void> {
  const root = process.cwd()
  const source = sourceIdentity(root)
  const rootManifest = readRootManifest(root)
  const working = mkdtempSync(join(tmpdir(), 'dsh-integration-release-'))
  try {
    const dshDirectory = join(working, 'dsh')
    const vendorDirectory = join(working, 'vendor')
    const nativeDirectory = join(working, 'native')
    await packFamily('dsh', dshDirectory)
    await packFamily('vendor', vendorDirectory)
    await runConcurrent('node', [join(root, NATIVE_ROOT, 'scripts/pack-release.mjs'), nativeDirectory, '--current-platform-only'])
    const packages = [
      ...readFamily('dsh', dshDirectory),
      ...readFamily('native', nativeDirectory),
      ...readFamily('vendor', vendorDirectory),
    ]
    const entry = verifyPackages(packages)
    const manifest = runtimeManifest(packages, rootManifest, entry.version)
    const lockDirectory = join(working, 'runtime')
    mkdirSync(lockDirectory)
    const lock = createLock(root, lockDirectory, manifest, packages)
    const rules = nodeRules(rootManifest.engine)
    const release = createIntegrationRelease({
      files: [
        { bytes: lock, path: 'bun.lock' },
        { bytes: manifest, path: 'package.json' },
        ...packages.map(item => ({ bytes: item.bytes, path: item.file })),
      ],
      packages,
      runtime: {
        engine: rootManifest.engine,
        entry: { name: 'dsh', package: entry.name, path: 'lib/bin.js', version: entry.version },
        ...rules,
        packageManager: rootManifest.packageManager,
        platform: `${process.platform}-${process.arch}`,
        toolPackage: SHELL_TOOL,
      },
      source,
    })
    const output = resolve(root, outputValue)
    prepareOutput(output)
    writeFileSync(join(output, INTEGRATION_CONTROL_FILE), release.controlBytes, { flag: 'wx' })
    writeFileSync(join(output, INTEGRATION_PACK_FILE), release.packBytes, { flag: 'wx' })
    console.log(`integration release: ${String(packages.length)} packages for ${process.platform}-${process.arch} in ${output}`)
  } finally {
    rmSync(working, { recursive: true, force: true })
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: false })
  await packIntegration(values.out)
}

if (isEntry(import.meta.url)) await main()
