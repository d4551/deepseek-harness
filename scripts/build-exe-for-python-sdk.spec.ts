import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const script = resolve(root, 'scripts/build-exe-for-python-sdk.ts')
const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

function run(env: NodeJS.ProcessEnv, ...args: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx/esm', script, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: isolatedBunEnvironment(env),
  })
}

describe('Python runtime executable builder CLI', () => {
  it('runs bun through the supplied entrypoint without a command shell', () => {
    const result = run(
      { npm_execpath: 'C:\\tools\\bun.exe' },
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-arm64',
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('C:\\tools\\bun.exe run verify-runtime-closure')
    expect(result.stdout).toContain('C:\\tools\\bun.exe install --cwd')
    expect(result.stdout).toContain('C:\\tools\\bun.exe x @yao-pkg/pkg@6.21.0')
    expect(result.stdout).not.toMatch(/bun\.cmd/i)
    expect(result.stdout).not.toMatch(/\bdlx\b/)
  })

  it('resolves the bun binary under BUN_INSTALL behind a Windows command shim', () => {
    const setup = mkdtempSync(join(tmpdir(), 'dsh-bun-home-'))
    temporaryDirectories.push(setup)
    const entrypoint = join(setup, 'bin', 'bun')
    mkdirSync(dirname(entrypoint), { recursive: true })
    writeFileSync(entrypoint, '')

    const result = run(
      { npm_execpath: 'C:\\tools\\bun.cmd', BUN_INSTALL: setup },
      '--skip-build',
      '--dry-run',
      '--targets=node24-macos-arm64',
    )

    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`${entrypoint} run verify-runtime-closure`)
    expect(result.stdout).not.toMatch(/bun\.cmd/i)
  })

  it('rejects a Windows arm64 product before any build step', () => {
    const result = run(
      { npm_execpath: 'C:\\tools\\bun.exe' },
      '--skip-build',
      '--dry-run',
      '--targets=node24-win-arm64',
    )

    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Windows supports x64 only')
    expect(result.stdout).toBe('')
  })
})

function isolatedBunEnvironment(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !['npm_execpath', 'bun_install'].includes(key.toLowerCase())),
  )
  return { ...environment, ...overrides }
}
