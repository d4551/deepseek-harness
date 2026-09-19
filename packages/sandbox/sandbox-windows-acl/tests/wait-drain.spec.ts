/**
 * Piped-child wait drain-all: both pipe drains settle through Thrown reject
 * arms before the exit wait starts, then every failure is reported.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { AclSandbox } from '../src/index.ts'
import { waitPipedChildOutcome } from '../src/spawn.ts'

function empty(): Buffer {
  return Buffer.alloc(0)
}

/** A Promise that rejects with leftover Thrown product text, not an Error wrapper. */
function leftoverReject(reason: object | string): Promise<Buffer> {
  return new Promise((_resolve) => {
    throw reason
  })
}

describe('waitPipedChildOutcome', () => {
  it('returns both drain buffers and the exit code when every step fulfills', async () => {
    await expect(waitPipedChildOutcome(
      Promise.resolve(Buffer.from('out')),
      Promise.resolve(Buffer.from('err')),
      () => Promise.resolve(7),
    )).resolves.toEqual({
      stdout: Buffer.from('out'),
      stderr: Buffer.from('err'),
      exitCode: 7,
    })
  })

  it('waits for the sibling drain and exit after a stdout Error rejection', async () => {
    let exitStarted = false
    let stderrSettled = false
    const stderr = Promise.resolve(empty()).then((buffer) => {
      stderrSettled = true
      return buffer
    })
    await expect(waitPipedChildOutcome(
      Promise.reject(new Error('stdout-broke')),
      stderr,
      () => {
        exitStarted = true
        expect(stderrSettled).toBe(true)
        return Promise.resolve(0)
      },
    )).rejects.toThrow('stdout-broke')
    expect(exitStarted).toBe(true)
  })

  it('waits for the sibling drain and exit after a stderr Error rejection', async () => {
    let exitStarted = false
    await expect(waitPipedChildOutcome(
      Promise.resolve(empty()),
      Promise.reject(new Error('stderr-broke')),
      () => {
        exitStarted = true
        return Promise.resolve(0)
      },
    )).rejects.toThrow('stderr-broke')
    expect(exitStarted).toBe(true)
  })

  it('reports every drain failure after both pipes and the exit wait settle', async () => {
    let exitStarted = false
    await expect(waitPipedChildOutcome(
      Promise.reject(new Error('stdout-broke')),
      Promise.reject(new Error('stderr-broke')),
      () => {
        exitStarted = true
        return Promise.resolve(0)
      },
    )).rejects.toMatchObject({
      message: /2 drain or exit failure/u,
      errors: [expect.objectContaining({ message: 'stdout-broke' }), expect.objectContaining({ message: 'stderr-broke' })],
    })
    expect(exitStarted).toBe(true)
  })

  it('reports an exit Error after both drains settle', async () => {
    await expect(waitPipedChildOutcome(
      Promise.resolve(empty()),
      Promise.resolve(empty()),
      () => Promise.reject(new Error('exit-broke')),
    )).rejects.toThrow('exit-broke')
  })

  it('wraps a non-Error drain rejection after the sibling drain and exit settle', async () => {
    let exitStarted = false
    await expect(waitPipedChildOutcome(
      leftoverReject('pipe-broke'),
      Promise.resolve(empty()),
      () => {
        exitStarted = true
        return Promise.resolve(0)
      },
    )).rejects.toMatchObject({
      message: /1 drain or exit failure/u,
      errors: ['pipe-broke'],
    })
    expect(exitStarted).toBe(true)
  })

  it('wraps a leftover object drain rejection without JSON text', async () => {
    const reason = { tag: 'pipe-object' }
    await expect(waitPipedChildOutcome(
      leftoverReject(reason),
      Promise.resolve(empty()),
      () => Promise.resolve(0),
    )).rejects.toMatchObject({
      message: /1 drain or exit failure/u,
      errors: [reason],
    })
  })

  it('reports drain and exit failures together after every arm settles', async () => {
    await expect(waitPipedChildOutcome(
      Promise.reject(new Error('stdout-broke')),
      Promise.reject(new Error('stderr-broke')),
      () => Promise.reject(new Error('exit-broke')),
    )).rejects.toMatchObject({
      message: /3 drain or exit failure/u,
      errors: [
        expect.objectContaining({ message: 'stdout-broke' }),
        expect.objectContaining({ message: 'stderr-broke' }),
        expect.objectContaining({ message: 'exit-broke' }),
      ],
    })
  })

  it('does not start the exit wait until both drains have settled', async () => {
    let releaseStderr: (() => void) | undefined
    const stderr = new Promise<Buffer>((resolve) => {
      releaseStderr = () => { resolve(empty()) }
    })
    let exitStarted = false
    const pending = waitPipedChildOutcome(
      Promise.reject(new Error('stdout-broke')),
      stderr,
      () => {
        exitStarted = true
        return Promise.resolve(0)
      },
    )
    await Promise.resolve()
    expect(exitStarted).toBe(false)
    releaseStderr?.()
    await expect(pending).rejects.toThrow('stdout-broke')
    expect(exitStarted).toBe(true)
  })
})

describe('AclSandbox construction', () => {
  const scratchDirs: string[] = []
  afterAll(() => {
    for (const dir of scratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  function scratch(): string {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-acl-wait-'))
    scratchDirs.push(dir)
    return dir
  }

  it('rejects workspace-write without a write SID', () => {
    const workspace = scratch()
    expect(() => new AclSandbox({ writableDirs: [workspace], tempDir: null, mode: 'workspace-write' }))
      .toThrow(/requires a write SID/u)
  })

  it('rejects workspace-write with temp and no temp write SID', () => {
    const workspace = scratch()
    expect(() => new AclSandbox({
      writableDirs: [workspace],
      tempDir: workspace,
      writeSid: 'S-1-4-1-1',
      mode: 'workspace-write',
    })).toThrow(/requires a temp write SID/u)
  })

  it('rejects identical workspace and temp write SIDs', () => {
    const workspace = scratch()
    expect(() => new AclSandbox({
      writableDirs: [workspace],
      tempDir: workspace,
      writeSid: 'S-1-4-1-1',
      tempWriteSid: 'S-1-4-1-1',
      mode: 'workspace-write',
    })).toThrow(/must be distinct/u)
  })
})
