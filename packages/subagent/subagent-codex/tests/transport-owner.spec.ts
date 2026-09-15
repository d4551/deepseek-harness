import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { CodexAppServerWire } from '../src/wire.ts'

describe('Codex wire transport ownership', () => {
  it('joins closure when startup never opened the transport', async () => {
    const wire = new CodexAppServerWire(new PassThrough(), new PassThrough(), 'never')
    wire.close()
    expect((await wire.waitForClosure()).message).toBe('JSON-RPC transport closed')
    wire.close()
    expect((await wire.waitForClosure()).message).toBe('JSON-RPC transport closed')
  })

  it('settles initialization before joining local transport closure', async () => {
    const input = new PassThrough()
    const output = new PassThrough()
    const wire = new CodexAppServerWire(input, output, 'never')
    wire.start()
    const initialized = expect(wire.initialize(new AbortController().signal))
      .rejects.toThrow('JSON-RPC transport closed')
    expect(output.readableLength).toBeGreaterThan(0)
    wire.close()
    await initialized
    expect((await wire.waitForClosure()).message).toBe('JSON-RPC transport closed')
    expect(input.listenerCount('data')).toBe(0)
  })
})
