import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, onTestFinished } from 'vitest'
import { coverageTestTimeoutArgs, forwardedCoverageArgs, runCoverageCommand, type CoverageCommand } from './coverage-command.ts'

describe('coverage arguments', () => {
  it.each([undefined, ''])('keeps default timeouts for %s', (value) => {
    expect(coverageTestTimeoutArgs(value)).toEqual([])
  })

  it('sets matching test and polling budgets', () => {
    expect(coverageTestTimeoutArgs('90000')).toEqual(['--testTimeout=90000', '--expect.poll.timeout=90000'])
  })

  it.each(['0', '-1', '01', '1.5', '2x', ' 2', '9007199254740992'])('rejects invalid timeout %s', (value) => {
    expect(() => coverageTestTimeoutArgs(value)).toThrow('DSH_COVERAGE_TEST_TIMEOUT_MS must be a positive integer')
  })

  it('removes only the leading package separator without changing the input', () => {
    const args = ['--', 'source.spec.ts', '--']
    expect(forwardedCoverageArgs(args)).toEqual(['source.spec.ts', '--'])
    expect(args).toEqual(['--', 'source.spec.ts', '--'])
    expect(forwardedCoverageArgs(['source.spec.ts'])).toEqual(['source.spec.ts'])
    expect(forwardedCoverageArgs([])).toEqual([])
  })
})

describe('real coverage command processes', () => {
  async function command(source: string): Promise<CoverageCommand> {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-coverage-command-'))
    onTestFinished(() => rm(directory, { recursive: true, force: true }))
    return {
      label: 'process boundary',
      command: process.execPath,
      args: ['-e', source],
      env: {},
      cwd: await realpath(directory),
    }
  }

  it('observes successful stdout and stderr after both streams close', async () => {
    const result = await runCoverageCommand(await command("process.stdout.write('out'); process.stderr.write('err')"))
    expect(result.exitCode).toBe(0)
    expect(result.signalCode).toBeNull()
    expect(result.error).toBeUndefined()
    expect(result.outputTail).toHaveLength(6)
    expect(result.outputTail).toContain('out')
    expect(result.outputTail).toContain('err')
  })

  it('preserves nonzero exit status and its diagnostic output', async () => {
    expect(await runCoverageCommand(await command("process.stderr.write('failure'); process.exitCode = 7")))
      .toEqual({ exitCode: 7, signalCode: null, outputTail: 'failure' })
  })

  it('reports a real signal with the host process semantics', async () => {
    const result = await runCoverageCommand(await command("process.kill(process.pid, 'SIGTERM')"))
    expect(result.error).toBeUndefined()
    expect(result.outputTail).toBe('')
    expect(result.exitCode).toBe(process.platform === 'win32' ? 1 : null)
    expect(result.signalCode).toBe(process.platform === 'win32' ? null : 'SIGTERM')
  })

  it('reports an executable launch failure', async () => {
    const subject = await command('process.exitCode = 0')
    subject.command = join(subject.cwd, 'missing-executable')
    const result = await runCoverageCommand(subject)
    expect(result.exitCode).toBeNull()
    expect(result.signalCode).toBeNull()
    expect(result.error).toContain('ENOENT')
    expect(result.outputTail).toBe('')
  })

  it('uses the requested directory and child-only environment changes', async () => {
    const subject = await command('process.stdout.write(JSON.stringify([process.cwd(), process.env.DSH_COVERAGE_COMMAND_VALUE, process.env.PATH]))')
    subject.env = { DSH_COVERAGE_COMMAND_VALUE: 'child value', PATH: undefined }
    const inheritedPath = process.env.PATH
    const result = await runCoverageCommand(subject)
    expect(result.exitCode).toBe(0)
    expect(result.outputTail).toBe(JSON.stringify([subject.cwd, 'child value', null]))
    expect(process.env.PATH).toBe(inheritedPath)
  })

  it('keeps only the latest 65536 characters of long process output', async () => {
    const result = await runCoverageCommand(await command("process.stdout.write('x'.repeat(65536) + 'final')"))
    expect(result.exitCode).toBe(0)
    expect(result.outputTail).toBe('x'.repeat(65531) + 'final')
  })
})
