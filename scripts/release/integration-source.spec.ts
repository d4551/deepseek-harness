import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bunInvocation } from '../bun-invocation.ts'
import { BUN_PIN } from '../live-stack-floors.ts'
import { INTEGRATION_CONTROL_FILE, INTEGRATION_PACK_FILE } from './integration-release-contract.ts'
import { integrationBuildInputs } from './integration-build-inputs.ts'
import { IntegrationSource } from './integration-source.ts'
import { capture, runConcurrent } from './process.ts'

const roots: string[] = []
const bun = bunInvocation([]).command

function write(path: string, bytes: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, bytes)
}

function fixture(prepack?: string): { readonly root: string; readonly working: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-integration-source-'))
  const working = mkdtempSync(join(tmpdir(), 'dsh-integration-build-'))
  roots.push(root, working)
  write(join(root, 'package.json'), JSON.stringify({
    name: 'release-build-fixture', private: true, packageManager: BUN_PIN,
    workspaces: ['packages/*'], dependencies: { '@deepseek-ai/member': 'workspace:*' },
    scripts: { 'build:official': 'node build.mjs', 'record-tools': 'node record-tools.mjs' },
  }))
  write(join(root, '.gitignore'), 'node_modules/\nlib/\n')
  write(join(root, 'packages/member/package.json'), JSON.stringify({
    name: '@deepseek-ai/member', version: '1.0.0', files: ['lib'],
    scripts: { prepack: 'node prepack.mjs' },
  }))
  write(join(root, 'packages/member/prepack.mjs'), [
    "import { strictEqual } from 'node:assert'",
    "import { readFileSync, realpathSync } from 'node:fs'",
    "import { execFileSync as execute } from 'node:child_process'",
    "const selected = JSON.parse(readFileSync('lib/toolchain.json', 'utf8'))",
    'strictEqual(realpathSync(process.execPath), selected.node)',
    "strictEqual(realpathSync(execute('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim()), selected.bun)",
    prepack?.replaceAll('ORIGIN_PATH', JSON.stringify(root)) ?? '',
  ].join('\n'))
  write(join(root, 'packages/member/src.js'), 'export const answer = 42\n')
  write(join(root, 'build.mjs'), [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
    "import { execFileSync } from 'node:child_process'",
    "mkdirSync('packages/member/lib', { recursive: true })",
    "writeFileSync('packages/member/lib/index.js', readFileSync('packages/member/src.js'))",
    "execFileSync('bun', ['run', 'record-tools'], { stdio: 'inherit' })",
  ].join('\n'))
  write(join(root, 'record-tools.mjs'), [
    "import { realpathSync, writeFileSync } from 'node:fs'",
    "import { execFileSync } from 'node:child_process'",
    "const bun = realpathSync(execFileSync('bun', ['-p', 'process.execPath'], { encoding: 'utf8' }).trim())",
    "writeFileSync('packages/member/lib/toolchain.json', JSON.stringify({ bun, node: realpathSync(process.execPath) }))",
  ].join('\n'))
  write(join(root, 'native/landlock-run/package.json'), JSON.stringify({
    name: 'native-build-fixture', private: true, scripts: { 'build:native': 'node build.mjs' },
  }))
  write(join(root, 'native/landlock-run/source.js'), 'export const nativeEntry = true\n')
  write(join(root, 'native/landlock-run/build.mjs'), [
    "import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'",
    "mkdirSync('lib', { recursive: true })",
    "writeFileSync('lib/index.js', readFileSync('source.js'))",
  ].join('\n'))
  capture(bun, ['install', '--lockfile-only'], { cwd: root })
  capture('git', ['init', '--quiet'], { cwd: root })
  capture('git', ['add', '.'], { cwd: root })
  capture('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '--quiet', '-m', 'build source'], { cwd: root })
  return { root, working }
}

async function built(root: string, working: string): Promise<IntegrationSource> {
  const source = IntegrationSource.capture(root, working)
  await source.build(BUN_PIN)
  source.retainBuildInputs(['packages/member', 'native/landlock-run'])
  return source
}

async function pack(source: IntegrationSource, working: string): Promise<string> {
  const destination = join(working, 'packages')
  mkdirSync(destination)
  await runConcurrent(source.bun, ['pm', 'pack', '--cwd', 'packages/member', '--destination', destination], source.processOptions)
  return join(destination, 'deepseek-ai-member-1.0.0.tgz')
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

describe('integration release source ownership', () => {
  it('builds and packs the exact commit without importing old ignored artifacts', async () => {
    const { root, working } = fixture()
    const hostile = join(working, 'foreign-tools')
    for (const executable of ['node', 'bun']) {
      write(join(hostile, executable), '#!/bin/sh\nexit 77\n')
      chmodSync(join(hostile, executable), 0o755)
    }
    vi.stubEnv('PATH', [hostile, process.env.PATH].join(delimiter))
    write(join(root, 'packages/member/lib/index.js'), 'old generated artifact\n')
    const source = IntegrationSource.capture(root, working)
    expect(existsSync(join(source.directory, 'packages/member/lib'))).toBe(false)
    expect(existsSync(join(source.directory, 'node_modules'))).toBe(false)
    await source.build(BUN_PIN)
    source.retainBuildInputs(['packages/member', 'native/landlock-run'])
    const tarball = await pack(source, working)
    source.verify()
    expect(JSON.parse(readFileSync(join(source.directory, 'packages/member/lib/toolchain.json'), 'utf8'))).toEqual({
      bun: source.bun, node: source.node,
    })
    expect(capture('tar', ['-xOzf', tarball, 'package/lib/index.js'])).toBe('export const answer = 42')
    expect(source.identity).toEqual({
      commit: capture('git', ['rev-parse', 'HEAD'], { cwd: root }),
      tree: capture('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }),
    })
    expect(readFileSync(join(root, 'packages/member/lib/index.js'), 'utf8')).toBe('old generated artifact\n')
    const output = join(working, 'published')
    source.publish(output, Buffer.from(JSON.stringify(source.identity)), readFileSync(tarball))
    expect(readdirSync(output).sort()).toEqual([INTEGRATION_CONTROL_FILE, INTEGRATION_PACK_FILE])
    expect(readFileSync(join(output, INTEGRATION_PACK_FILE))).toEqual(readFileSync(tarball))
    expect(readdirSync(working).some(name => name.startsWith('.published-'))).toBe(false)
    const emptyOutput = join(working, 'empty-published')
    mkdirSync(emptyOutput)
    source.publish(emptyOutput, Buffer.from(JSON.stringify(source.identity)), readFileSync(tarball))
    expect(readFileSync(join(emptyOutput, INTEGRATION_PACK_FILE))).toEqual(readFileSync(tarball))
    expect(() => { source.publish(join(root, 'release-output'), Buffer.from('control'), Buffer.from('pack')) }).toThrow(/outside the source checkout/)
    expect(existsSync(join(root, 'release-output'))).toBe(false)
    const nodeSelection = join(working, 'toolchain/node')
    unlinkSync(nodeSelection)
    symlinkSync(source.bun, nodeSelection)
    expect(() => { source.verify() }).toThrow(/executable selection changed/)
  })

  it.each(['packages/member/src.js', '.agents/note.md', 'goal/objective.md'])('rejects dirty %s before creating a snapshot', (path) => {
    const { root, working } = fixture()
    write(join(root, path), 'changed source\n')
    expect(() => IntegrationSource.capture(root, working)).toThrow(/clean source tree/)
    expect(readdirSync(working)).toEqual([])
  })

  it('rejects a different Bun pin without running the build', async () => {
    const { root, working } = fixture()
    const source = IntegrationSource.capture(root, working)
    await expect(source.build('bun@0.0.1')).rejects.toThrow(/Bun executable differs/)
    expect(existsSync(join(source.directory, 'packages/member/lib'))).toBe(false)
    expect(() => { source.retainBuildInputs(['packages/member']) }).toThrow(/not ready/)
    expect(() => { source.publish(join(working, 'published'), Buffer.from('control'), Buffer.from('pack')) }).toThrow(/not retained/)
    expect(existsSync(join(working, 'published'))).toBe(false)
  })

  it('rejects an outdated frozen lock before running the build', async () => {
    const { root, working } = fixture()
    write(join(root, 'packages/second/package.json'), JSON.stringify({ name: '@deepseek-ai/second', version: '1.0.0' }))
    capture('git', ['add', '.'], { cwd: root })
    capture('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '--quiet', '-m', 'unresolved workspace'], { cwd: root })
    const source = IntegrationSource.capture(root, working)
    await expect(source.build(BUN_PIN)).rejects.toThrow(/exited/)
    expect(existsSync(join(source.directory, 'packages/member/lib'))).toBe(false)
  })

  it.each(['edit', 'commit'])('rejects a real source %s performed while Bun packs', async (change) => {
    const { root, working } = fixture([
      "import { writeFileSync } from 'node:fs'",
      "import { join } from 'node:path'",
      "import { execFileSync } from 'node:child_process'",
      'const root = ORIGIN_PATH',
      "writeFileSync(join(root, 'packages/member/src.js'), 'changed during pack\\n')",
      ...(change === 'commit' ? [
        "execFileSync('git', ['add', '.'], { cwd: root })",
        "execFileSync('git', ['-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '--quiet', '-m', 'changed during pack'], { cwd: root })",
      ] : []),
    ].join('\n'))
    const source = await built(root, working)
    await pack(source, working)
    expect(() => { source.verify() }).toThrow(/clean source tree|source commit or tree changed/)
    expect(() => { source.publish(join(working, 'published'), Buffer.from('control'), Buffer.from('pack')) }).toThrow()
    expect(existsSync(join(working, 'published'))).toBe(false)
  })

  it('rejects a prepack script that changes freshly built bytes', async () => {
    const { root, working } = fixture("import { writeFileSync } from 'node:fs'; writeFileSync('lib/index.js', 'changed artifact\\n')")
    const source = await built(root, working)
    await pack(source, working)
    expect(() => { source.verify() }).toThrow(/build inputs changed/)
    expect(() => { source.publish(join(working, 'published'), Buffer.from('control'), Buffer.from('pack')) }).toThrow(/build inputs changed/)
    expect(existsSync(join(working, 'published'))).toBe(false)
  })

  it.each(['added', 'removed', 'outside link'])('rejects %s physical pack inputs', async (change) => {
    const { root, working } = fixture()
    const source = await built(root, working)
    const path = join(source.directory, 'packages/member/lib/index.js')
    if (change === 'added') write(join(dirname(path), 'unreviewed.js'), 'new generated artifact\n')
    if (change === 'removed') unlinkSync(path)
    if (change === 'outside link') {
      unlinkSync(path)
      symlinkSync(join(root, 'packages/member/src.js'), path)
    }
    expect(() => { source.verify() }).toThrow(/build inputs changed|escapes its source/)
  })

  it('preserves an occupied publication directory and leaves no staging output', async () => {
    const { root, working } = fixture()
    const source = await built(root, working)
    const output = join(working, 'published')
    write(join(output, 'operator.txt'), 'retained\n')
    expect(() => { source.publish(output, Buffer.from('control'), Buffer.from('pack')) }).toThrow(/not empty/)
    expect(readdirSync(output)).toEqual(['operator.txt'])
    expect(readFileSync(join(output, 'operator.txt'), 'utf8')).toBe('retained\n')
    expect(readdirSync(working).some(name => name.startsWith('.published-'))).toBe(false)
  })

  it('binds physical contents reached through internal directory links', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-integration-inputs-'))
    roots.push(root)
    const physical = join(root, 'physical')
    write(join(physical, 'index.js'), 'original artifact\n')
    symlinkSync(physical, join(root, 'package'))
    symlinkSync(join(root, 'package'), join(physical, 'cycle'))
    const initial = integrationBuildInputs(root, ['package'])
    expect(integrationBuildInputs(root, ['package'])).toBe(initial)
    write(join(physical, 'index.js'), 'altered artifact\n')
    expect(integrationBuildInputs(root, ['package'])).not.toBe(initial)
  })
})
