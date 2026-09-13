import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { bunInvocation } from '../bun-invocation.ts'
import { INTEGRATION_CONTROL_FILE, INTEGRATION_PACK_FILE } from './integration-release-contract.ts'
import { integrationBuildInputs } from './integration-build-inputs.ts'
import { integrationEnvironment } from './integration-environment.ts'
import { capture, runConcurrent } from './process.ts'

interface SourceIdentity {
  readonly commit: string
  readonly tree: string
}

function sourceIdentity(root: string): SourceIdentity {
  const status = capture('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: root })
  if (status !== '') throw new Error(`integration release requires a clean source tree:\n${status}`)
  const commit = capture('git', ['rev-parse', 'HEAD'], { cwd: root })
  const tree = capture('git', ['rev-parse', `${commit}^{tree}`], { cwd: root })
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) {
    throw new Error('integration release Git identity is invalid')
  }
  return { commit, tree }
}

function fileDigest(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Own the exact source, fresh build, and publication lifetime of one integration release. */
export class IntegrationSource {
  readonly #origin: string
  readonly #identity: SourceIdentity
  readonly #bunDigest: string
  readonly #nodeDigest: string
  readonly #tools: string
  readonly #directories: string[] = []
  #inputs: string | undefined
  #built = false
  readonly directory: string
  readonly bun: string
  readonly node: string

  private constructor(origin: string, directory: string, identity: SourceIdentity) {
    this.#origin = realpathSync(origin)
    this.directory = realpathSync(directory)
    this.#identity = identity
    this.bun = realpathSync(bunInvocation([]).command)
    this.node = realpathSync(process.execPath)
    this.#bunDigest = fileDigest(this.bun)
    this.#nodeDigest = fileDigest(this.node)
    this.#tools = join(dirname(this.directory), 'toolchain')
    mkdirSync(this.#tools)
    symlinkSync(this.bun, join(this.#tools, 'bun'))
    symlinkSync(this.node, join(this.#tools, 'node'))
  }

  /** Materialize only the retained Git commit, without caller build or install residue. */
  static capture(origin: string, working: string): IntegrationSource {
    const identity = sourceIdentity(origin)
    const directory = join(working, 'source')
    capture('git', ['clone', '--no-local', '--no-checkout', '--', origin, directory])
    capture('git', ['checkout', '--detach', identity.commit], { cwd: directory })
    const source = new IntegrationSource(origin, directory, identity)
    source.verifySource()
    return source
  }

  get identity(): SourceIdentity {
    return { ...this.#identity }
  }

  get processOptions(): { readonly cwd: string; readonly env: NodeJS.ProcessEnv } {
    return { cwd: this.directory, env: integrationEnvironment(this.#tools, this.bun) }
  }

  private verifySource(): void {
    for (const root of [this.#origin, this.directory]) {
      const current = sourceIdentity(root)
      if (current.commit !== this.#identity.commit || current.tree !== this.#identity.tree) {
        throw new Error('integration release source commit or tree changed')
      }
    }
    if (fileDigest(this.bun) !== this.#bunDigest || fileDigest(this.node) !== this.#nodeDigest) {
      throw new Error('integration release toolchain bytes changed')
    }
    if (readlinkSync(join(this.#tools, 'bun')) !== this.bun
      || readlinkSync(join(this.#tools, 'node')) !== this.node) {
      throw new Error('integration release toolchain executable selection changed')
    }
  }

  /** Execute the repository build from a new frozen installation of its pinned Bun lock. */
  async build(packageManager: string): Promise<void> {
    if (this.#built) throw new Error('integration release source was already built')
    this.verifySource()
    if (`bun@${capture(this.bun, ['--version'])}` !== packageManager) {
      throw new Error('integration release Bun executable differs from packageManager')
    }
    const options = this.processOptions
    await runConcurrent(this.bun, ['install', '--frozen-lockfile', '--backend=copyfile'], options)
    this.verifySource()
    await runConcurrent(this.bun, ['run', 'build:official'], options)
    if (process.platform === 'linux') {
      await runConcurrent(this.bun, ['run', '--cwd', 'native/landlock-run', 'build:native'], options)
    }
    this.verifySource()
    this.#built = true
  }

  /** Retain the complete physical inputs selected by the canonical package families. */
  retainBuildInputs(directories: readonly string[]): void {
    if (!this.#built || this.#inputs !== undefined) throw new Error('integration build is not ready for input retention')
    this.verifySource()
    this.#directories.push(...directories)
    this.#inputs = integrationBuildInputs(this.directory, this.#directories)
  }

  /** Deny source, toolchain, or physical package changes across asynchronous packing. */
  verify(): void {
    this.verifySource()
    if (!this.#built || this.#inputs === undefined
      || integrationBuildInputs(this.directory, this.#directories) !== this.#inputs) {
      throw new Error('integration release build inputs changed or were not retained')
    }
  }

  /** Publish both complete files with one directory rename after the final identity check. */
  publish(output: string, control: Uint8Array, pack: Uint8Array): void {
    this.verify()
    const requested = resolve(output)
    mkdirSync(dirname(requested), { recursive: true })
    const destination = join(realpathSync(dirname(requested)), basename(requested))
    const sourceRelative = relative(this.#origin, destination)
    if (sourceRelative !== '..' && !sourceRelative.startsWith(`..${sep}`) && !isAbsolute(sourceRelative)) {
      throw new Error('integration release output must be outside the source checkout')
    }
    if (existsSync(destination) && readdirSync(destination).length !== 0) {
      throw new Error(`integration release output is not empty: ${destination}`)
    }
    const staging = mkdtempSync(join(dirname(destination), `.${basename(destination)}-`))
    try {
      writeFileSync(join(staging, INTEGRATION_CONTROL_FILE), control, { flag: 'wx' })
      writeFileSync(join(staging, INTEGRATION_PACK_FILE), pack, { flag: 'wx' })
      this.verify()
      renameSync(staging, destination)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
}
