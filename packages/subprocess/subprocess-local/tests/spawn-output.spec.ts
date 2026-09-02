import { readFileSync, statSync, unlinkSync } from 'node:fs'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OutputCollector, spawnSubprocess } from '../src/spawn.ts'
import { finish, spec, spillDir } from './spawn-support.ts'

const { failNextClose, failNextUnlink } = vi.hoisted(() => ({
  failNextClose: { value: false },
  failNextUnlink: { value: false } }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    closeSync(fd: number): void {
      if (failNextClose.value) {
        failNextClose.value = false
        throw Object.assign(new Error('simulated EIO on close'), { code: 'EIO' })
      }
      actual.closeSync(fd)
    },
    unlinkSync(path: Parameters<typeof actual.unlinkSync>[0]): void {
      if (failNextUnlink.value) {
        failNextUnlink.value = false
        throw Object.assign(new Error('simulated EIO on unlink'), { code: 'EIO' })
      }
      actual.unlinkSync(path)
    },
  }
})

describe('output truncation and spill', () => {
  it('applies stdout and stderr caps independently', async () => {
    const result = await finish(spawnSubprocess(
      spec('printf "%.0sx" $(seq 1 500); printf "%.0se" $(seq 1 500) >&2', {
        stdoutMaxBytes: 500,
        stderrMaxBytes: 100,
      }),
      { spillDir },
    ))
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text).toBe('x'.repeat(500))
    expect(result.stderr.truncated).toBe(true)
    expect(result.stderr.text.length).toBeLessThanOrEqual(100)
  })

  it('keeps the tail and spills the full stream to disk', async () => {
    // 200 numbered lines of ~10 bytes; cap at 500 bytes keeps a late tail.
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text.length).toBeLessThanOrEqual(500)
    expect(result.stdout.text).toContain('line-0200')
    expect(result.stdout.text).not.toContain('line-0001')
    expect(result.stdout.spillPath).toBeDefined()
    const full = readFileSync(result.stdout.spillPath!, 'utf8')
    expect(full).toContain('line-0001')
    expect(full).toContain('line-0200')
  })

  it('does not truncate output exactly at the cap', async () => {
    const result = await finish(spawnSubprocess(
      spec('printf "%.0sx" $(seq 1 500)', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    expect(result.stdout.truncated).toBe(false)
    expect(result.stdout.text.length).toBe(500)
    expect(result.stdout.spillPath).toBeUndefined()
  })

  it('settles with the tail and no spill path when final spill close fails', async () => {
    failNextClose.value = true
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    expect(failNextClose.value).toBe(false)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.truncated).toBe(true)
    expect(result.stdout.text).toContain('line-0200')
    expect(result.stdout.spillPath).toBeUndefined()
  })
})

describe('OutputCollector', () => {
  it('keeps the tail of a single oversized chunk', () => {
    const collector = new OutputCollector(10, 100, 'test', spillDir)
    collector.push(Buffer.from('0123456789abcdef'))
    const out = collector.finalize()
    expect(out.text).toBe('6789abcdef')
    expect(out.truncated).toBe(true)
    expect(readFileSync(out.spillPath!, 'utf8')).toBe('0123456789abcdef')
  })

  it('retains a byte-exact tail across uneven chunk boundaries', () => {
    // A diagnostic tail must be exactly the LAST maxBytes regardless of
    // chunking; dropping only whole chunks would under-retain.
    const collector = new OutputCollector(10, undefined, 'exact-tail', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbbbb'))
    collector.push(Buffer.from('cc'))
    const out = collector.finalize()
    expect(out.text).toBe('aabbbbbbcc')
    expect(Buffer.byteLength(out.text)).toBe(10)
    expect(out.truncated).toBe(true)
  })

  it('readFrom returns increments and flags lossy reads', () => {
    const collector = new OutputCollector(10, 100, 'test', spillDir)
    collector.push(Buffer.from('aaaaa'))
    const first = collector.readFrom(0)
    expect(first.text).toBe('aaaaa')
    expect(first.lossy).toBe(false)
    expect(first.nextOffset).toBe(5)

    collector.push(Buffer.from('bbbbb'))
    const second = collector.readFrom(first.nextOffset)
    expect(second.text).toBe('bbbbb')
    expect(second.lossy).toBe(false)

    // Push enough to slide the window past the last offset.
    collector.push(Buffer.from('c'.repeat(20)))
    const third = collector.readFrom(second.nextOffset)
    expect(third.lossy).toBe(true)
    expect(third.text).toBe('c'.repeat(10))
    expect(third.spillPath).toBeDefined()
  })

  it('contains close failures and drops the spill path', () => {
    const collector = new OutputCollector(4, 100, 'closefail', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    expect(collector.readFrom(0).spillPath).toBeDefined()

    failNextClose.value = true
    let out: ReturnType<typeof collector.finalize>
    expect(() => { out = collector.finalize() }).not.toThrow()

    expect(failNextClose.value).toBe(false)
    expect(out!.text).toBe('bbbb')
    expect(out!.truncated).toBe(true)
    expect(out!.spillPath).toBeUndefined()
  })

  it('discards a spill that exceeds its configured cap', () => {
    const collector = new OutputCollector(4, 8, 'bounded', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    const spillPath = collector.readFrom(0).spillPath!
    expect(readFileSync(spillPath, 'utf8')).toBe('aaaabbbb')

    collector.push(Buffer.from('c'))
    collector.push(Buffer.from('dddd'))
    const out = collector.finalize()
    expect(out.text).toBe('dddd')
    expect(out.truncated).toBe(true)
    expect(out.spillPath).toBeUndefined()
    expect(() => readFileSync(spillPath)).toThrow()
  })

  it('does not create a spill when the first overflowing chunk exceeds the cap', () => {
    const collector = new OutputCollector(4, 4, 'no-spill', spillDir)
    collector.push(Buffer.from('abcdefgh'))
    const out = collector.finalize()
    expect(out.text).toBe('efgh')
    expect(out.truncated).toBe(true)
    expect(out.spillPath).toBeUndefined()
  })

  it('contains cleanup failures while disabling an oversize spill', () => {
    const collector = new OutputCollector(4, 8, 'cleanup-fail', spillDir)
    collector.push(Buffer.from('aaaa'))
    collector.push(Buffer.from('bbbb'))
    const spillPath = collector.readFrom(0).spillPath!

    failNextClose.value = true
    failNextUnlink.value = true
    expect(() => { collector.push(Buffer.from('c')) }).not.toThrow()
    expect(failNextClose.value).toBe(false)
    expect(failNextUnlink.value).toBe(false)
    expect(collector.finalize().spillPath).toBeUndefined()
    unlinkSync(spillPath)
  })
})

describe('stdio dispositions', () => {
  it("'pipe' exposes raw streams for caller-owned protocol decoding", async () => {
    const running = spawnSubprocess({
      ...spec('cat'),
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 1000 } },
    })
    expect(running.stdin).toBeDefined()
    expect(running.stdout).toBeDefined()
    expect(running.stderr).toBeUndefined()
    expect(running.collected.stdout).toBeUndefined()
    expect(running.collected.stderr).toBeDefined()

    const echoed = new Promise<string>((resolve) => {
      let text = ''
      running.stdout!.on('data', (chunk: Buffer) => { text += chunk.toString('utf8') })
      running.stdout!.on('end', () => { resolve(text) })
    })
    running.stdin!.end('through the pipe\n')
    const outcome = await running.done
    expect(outcome.exitCode).toBe(0)
    expect(await echoed).toBe('through the pipe\n')
  })

  it('a collect mode without spill keeps only the in-memory tail (no file)', async () => {
    const running = spawnSubprocess({
      ...spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done'),
      stdio: { stdin: 'ignore', stdout: { maxBytes: 100 }, stderr: { maxBytes: 100 } },
    }, { spillDir })
    await running.done
    const read = running.collected.stdout!.readFrom(0)
    expect(read.lossy).toBe(true)
    expect(read.text).toContain('line-0200')
    expect(read.spillPath).toBeUndefined()
  })
})

describe('spill-file permissions', () => {
  it('creates spill files with owner-only permissions and random names', async () => {
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
      { spillDir },
    ))
    const path = result.stdout.spillPath!
    expect(path).toMatch(/dsh-subprocess-\d+-\d+-[0-9a-f]{12}-stdout\.log$/)
    // POSIX enforces the owner-only mode; win32 has no per-file mode bits.
    if (process.platform !== 'win32') {
      const mode = statSync(path).mode & 0o777
      expect(mode).toBe(0o600)
    }
  })

  it('defaults spills into a private per-process directory', async () => {
    const result = await finish(spawnSubprocess(
      spec('for i in $(seq 1 200); do printf "line-%04d\\n" $i; done', { stdoutMaxBytes: 500, stderrMaxBytes: 500 }),
    ))
    const dir = dirname(result.stdout.spillPath!)
    expect(dir).toMatch(/dsh-subprocess-/)
    if (process.platform !== 'win32') {
      const mode = statSync(dir).mode & 0o777
      expect(mode).toBe(0o700)
    }
  })
})
