/**
 * How the command directory names a failure that carries no Error: a pull
 * rejecting with a bare value and an abort whose reason is not an Error both
 * reach the caller as an Error with a stated reason. The main directory
 * suite owns the Error-carrying paths.
 */
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { CommandDescriptor } from '../src/client/directory.ts'
import { CommandDirectory } from '../src/client/directory.ts'

const SESSION = 's1' as SessionId

describe('failure reasons that are not Errors', () => {
  it('names a bare pull rejection by its string form', async () => {
    const rejects: ((reason: string) => void)[] = []
    const dir = new CommandDirectory(() => new Promise<readonly CommandDescriptor[]>((_resolve, reject) => { rejects.push(reject) }))
    const wait = dir.ensureReady(SESSION, new AbortController().signal)
    rejects[0]?.('no directory')
    await expect(wait).rejects.toThrow('command directory warmup failed: no directory')
    expect(dir.status(SESSION)).toBe('failed')
  })

  it('states its own reason when the abort carries none that is an Error', async () => {
    const dir = new CommandDirectory(() => new Promise<readonly CommandDescriptor[]>(() => {}))
    const controller = new AbortController()
    const wait = dir.ensureReady(SESSION, controller.signal)
    controller.abort('stop')
    await expect(wait).rejects.toThrow('command directory wait aborted')
  })
})
