/**
 * Leftover Promise reject/fail arms on the shell process child and host claim
 * Thrown values and render them as product text, including filesystem replies
 * that carry a Node code.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MemoryVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/memory.ts'
import { setActiveVfs } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/storage/active.ts'
import { startProcess } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/host.ts'
import { runShellProcess } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/child.ts'
import { isShellStartFrame } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/protocol.ts'
import type { FromProcessFrame, ToProcessFrame } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/protocol.ts'
import type { ProcessScope } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/process/child.ts'
import type { ShellFileSystem } from '@deepseek-ai/dsh-experimental-webworker-runtime/src/shell/types.ts'

const WORKSPACE = '/dsh/workspace'
const WORKER_URL = 'https://example.test/assets/worker.js'

let vfs: MemoryVfs
let started: LoopbackWorker[]

function leftoverFn(): void {}
const leftoverSymbol = Symbol('leftover')

type LeftoverCase = {
  label: string
  reason: object | string | number | boolean | bigint | symbol | null | undefined
  text: string
}

const leftoverCases: LeftoverCase[] = [
  { label: 'string', reason: 'leftover-string', text: 'leftover-string' },
  { label: 'number', reason: 42, text: '42' },
  { label: 'boolean', reason: true, text: 'true' },
  { label: 'bigint', reason: 1n, text: '1' },
  { label: 'symbol', reason: leftoverSymbol, text: 'Symbol(leftover)' },
  { label: 'null', reason: null, text: 'null' },
  { label: 'undefined', reason: undefined, text: 'undefined' },
  { label: 'object', reason: { tag: 'leftover' }, text: '[object Object]' },
  { label: 'function', reason: leftoverFn, text: String(leftoverFn) },
  { label: 'Error', reason: new Error('leftover-error'), text: 'Error: leftover-error' },
]

function leftoverFs(reason: object | string | number | boolean | bigint | symbol | null | undefined): ShellFileSystem {
  const refuse = async (): Promise<never> => {
    throw reason
  }
  return {
    stat: refuse,
    list: refuse,
    readText: refuse,
    writeText: refuse,
    mkdir: refuse,
    remove: refuse,
    rename: refuse,
  }
}

/** Truncation succeeds; the append after the command body rejects leftover Thrown. */
function leftoverAppendFs(reason: object | string | number | boolean | bigint | symbol | null | undefined): ShellFileSystem {
  return {
    stat: async () => undefined,
    list: async () => [],
    readText: async () => '',
    writeText: async (_path, _text, append = false) => {
      if (append) throw reason
    },
    mkdir: async () => {},
    remove: async () => {},
    rename: async () => {},
  }
}

/**
 * A `Worker` that keeps the child half on this thread and records host frames
 * so leftover filesystem replies and unknown ops are observable.
 */
class LoopbackWorker {
  readonly url: string
  readonly moduleWorker: boolean
  terminated = false
  readonly hostToChild: unknown[] = []
  private readonly hostListeners: EventListener[] = []
  private readonly errorListeners: EventListener[] = []
  private childListener: ((event: MessageEvent) => void) | undefined
  private closed = false

  constructor(url: string | URL, options?: { type?: string }) {
    this.url = String(url)
    this.moduleWorker = options?.type === 'module'
    started.push(this)
  }

  postMessage(frame: ToProcessFrame): void {
    this.hostToChild.push(frame)
    if (this.terminated) return
    queueMicrotask(() => {
      if (this.terminated) return
      if (isShellStartFrame(frame)) {
        runShellProcess(frame, {
          postMessage: (reply: FromProcessFrame) => { this.toHost(reply) },
          addEventListener: (_type: 'message', listener: (event: MessageEvent) => void) => { this.childListener = listener },
          close: () => { this.closed = true },
        })
        return
      }
      this.childListener?.({ data: frame } as MessageEvent)
    })
  }

  private toHost(frame: FromProcessFrame): void {
    if (this.terminated) return
    queueMicrotask(() => {
      if (this.terminated) return
      for (const listener of this.hostListeners) listener({ data: frame } as MessageEvent)
    })
  }

  addEventListener(type: 'message' | 'error', listener: EventListener): void {
    if (type === 'message') this.hostListeners.push(listener)
    else this.errorListeners.push(listener)
  }

  terminate(): void {
    this.terminated = true
  }

  injectHost(frame: unknown): void {
    for (const listener of this.hostListeners) listener({ data: frame } as MessageEvent)
  }

  injectChild(frame: unknown): void {
    this.childListener?.({ data: frame } as MessageEvent)
  }

  emitError(message: string): void {
    for (const listener of this.errorListeners) listener({ message } as ErrorEvent)
  }

  get childClosed(): boolean {
    return this.closed
  }
}

function stubWorker(): void {
  vi.stubGlobal('Worker', LoopbackWorker)
  vi.stubGlobal('self', { location: { href: WORKER_URL } })
}

beforeEach(() => {
  vfs = new MemoryVfs()
  setActiveVfs(vfs)
  vfs.mkdirSync(WORKSPACE, { recursive: true })
  started = []
})

afterEach(() => {
  vi.unstubAllGlobals()
})

it.each(leftoverCases)('child reject arm claims leftover $label', async ({ reason, text }) => {
  const frames: FromProcessFrame[] = []
  let closed = false
  let childListener: ((event: MessageEvent) => void) | undefined
  const scope: ProcessScope = {
    postMessage(frame) {
      if (frame.t === 'fs-call') {
        if (frame.op === 'writeText' && frame.args[2] === true) throw reason
        queueMicrotask(() => {
          childListener?.({ data: { t: 'fs-reply', id: frame.id } } as MessageEvent)
        })
        return
      }
      frames.push(frame)
    },
    addEventListener(_type, listener) { childListener = listener },
    close() { closed = true },
  }
  runShellProcess({
    t: 'shell-start',
    script: 'echo hi > file.txt',
    argv: ['bash', '-c', 'echo hi > file.txt'],
    cwd: WORKSPACE,
    env: {},
    stdin: '',
  }, scope)
  await vi.waitFor(() => { expect(frames.some(frame => frame.t === 'shell-exit')).toBe(true) })
  expect(frames).toEqual([
    { t: 'shell-out', stream: 'stderr', text: `bash: ${text}\n` },
    { t: 'shell-exit', code: 1 },
  ])
  expect(closed).toBe(true)
})

it.each(leftoverCases)('inline reject arm claims leftover $label', async ({ reason, text }) => {
  let stderr = ''
  const code = await new Promise<number>((settle) => {
    startProcess({
      script: 'echo hi > file.txt',
      argv: ['bash', '-c', 'echo hi > file.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      fs: leftoverAppendFs(reason),
      onOutput(stream, chunk) {
        if (stream === 'stderr') stderr += chunk
      },
      onExit: settle,
    })
  })
  expect(code).toBe(1)
  expect(stderr).toBe(`bash: ${text}\n`)
})

it.each(leftoverCases.filter(entry => entry.label !== 'Error'))(
  'host filesystem reject arm claims leftover $label',
  async ({ reason, text }) => {
    stubWorker()
    let stderr = ''
    const code = await new Promise<number>((settle) => {
      startProcess({
        script: 'cat missing.txt',
        argv: ['bash', '-c', 'cat missing.txt'],
        cwd: WORKSPACE,
        env: {},
        stdin: '',
        fs: leftoverFs(reason),
        onOutput(stream, chunk) {
          if (stream === 'stderr') stderr += chunk
        },
        onExit: settle,
      })
    })
    expect(code).toBe(1)
    expect(stderr).toBe(`cat: missing.txt: EIO: fs failed, fs '${text}'\n`)
  },
)

it('host filesystem reject arm uses a leftover Error message without a code', async () => {
  stubWorker()
  let stderr = ''
  const code = await new Promise<number>((settle) => {
    startProcess({
      script: 'cat missing.txt',
      argv: ['bash', '-c', 'cat missing.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      fs: leftoverFs(new Error('leftover-error')),
      onOutput(stream, chunk) {
        if (stream === 'stderr') stderr += chunk
      },
      onExit: settle,
    })
  })
  expect(code).toBe(1)
  expect(stderr).toBe('cat: missing.txt: EIO: fs failed, fs \'leftover-error\'\n')
})

it('host filesystem reject arm keeps a leftover Error code', async () => {
  stubWorker()
  const coded = Object.assign(new Error('missing'), { code: 'ENOENT' })
  let stderr = ''
  const code = await new Promise<number>((settle) => {
    startProcess({
      script: 'cat missing.txt',
      argv: ['bash', '-c', 'cat missing.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      fs: leftoverFs(coded),
      onOutput(stream, chunk) {
        if (stream === 'stderr') stderr += chunk
      },
      onExit: settle,
    })
  })
  expect(code).toBe(1)
  expect(stderr).toBe('cat: missing.txt: No such file or directory\n')
})

it('host filesystem reject arm keeps a leftover object code and drops a non-string code', async () => {
  stubWorker()
  let codedStderr = ''
  const coded = await new Promise<number>((settle) => {
    startProcess({
      script: 'cat missing.txt',
      argv: ['bash', '-c', 'cat missing.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      fs: leftoverFs({ code: 'ENOENT' }),
      onOutput(stream, chunk) {
        if (stream === 'stderr') codedStderr += chunk
      },
      onExit: settle,
    })
  })
  expect(coded).toBe(1)
  expect(codedStderr).toBe('cat: missing.txt: No such file or directory\n')

  let numberedStderr = ''
  const numbered = await new Promise<number>((settle) => {
    startProcess({
      script: 'cat missing.txt',
      argv: ['bash', '-c', 'cat missing.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      fs: leftoverFs({ code: 1 }),
      onOutput(stream, chunk) {
        if (stream === 'stderr') numberedStderr += chunk
      },
      onExit: settle,
    })
  })
  expect(numbered).toBe(1)
  expect(numberedStderr).toBe('cat: missing.txt: EIO: fs failed, fs \'[object Object]\'\n')
})

it('child fail arm uses EIO when a filesystem reply has no code', async () => {
  stubWorker()
  const running = startProcess({
    script: 'sleep 30',
    argv: ['bash', '-c', 'sleep 30'],
    cwd: WORKSPACE,
    env: {},
    stdin: '',
    onOutput() {},
    onExit() {},
  })
  await vi.waitFor(() => { expect(started).toHaveLength(1) })
  const worker = started[0]
  if (worker === undefined) {
    throw new Error('loopback worker was not constructed')
  }
  worker.injectChild({ t: 'ignored' })
  worker.injectChild({ t: 'fs-reply', id: 999, value: 1 })
  worker.injectHost({ t: 'fs-call', id: 99, op: 'nope', args: [] })
  await vi.waitFor(() => {
    expect(worker.hostToChild.some((frame) => {
      return typeof frame === 'object' && frame !== null && 't' in frame && frame.t === 'fs-reply'
        && 'id' in frame && frame.id === 99 && 'failure' in frame
    })).toBe(true)
  })
  const reply = worker.hostToChild.find((frame) => {
    return typeof frame === 'object' && frame !== null && 't' in frame && frame.t === 'fs-reply'
      && 'id' in frame && frame.id === 99
  })
  expect(reply).toMatchObject({
    t: 'fs-reply',
    id: 99,
    failure: { message: 'webworker shell: unknown filesystem op nope' },
  })
  running.destroy()
})

it('worker error settles once and later destroy or interrupt does not republish', async () => {
  stubWorker()
  const exits: number[] = []
  let stderr = ''
  const running = startProcess({
    script: 'sleep 30',
    argv: ['bash', '-c', 'sleep 30'],
    cwd: WORKSPACE,
    env: {},
    stdin: '',
    onOutput(stream, text) {
      if (stream === 'stderr') stderr += text
    },
    onExit(code) { exits.push(code) },
  })
  await vi.waitFor(() => { expect(started).toHaveLength(1) })
  started[0]?.emitError('boom')
  await vi.waitFor(() => { expect(exits).toEqual([1]) })
  expect(stderr).toBe('bash: process worker failed: boom\n')
  running.destroy()
  running.interrupt()
  started[0]?.emitError('late')
  expect(exits).toEqual([1])
  expect(stderr).toBe('bash: process worker failed: boom\nbash: process worker failed: late\n')
})

it('worker interrupt asks the child to stop and argv without a script uses the program path', async () => {
  stubWorker()
  const exits: number[] = []
  const sleeping = startProcess({
    script: 'sleep 30',
    argv: ['bash', '-c', 'sleep 30'],
    cwd: WORKSPACE,
    env: {},
    stdin: '',
    onOutput() {},
    onExit(code) { exits.push(code) },
  })
  await vi.waitFor(() => { expect(started).toHaveLength(1) })
  sleeping.interrupt()
  await vi.waitFor(() => { expect(exits).toEqual([130]) })

  vfs.writeFileSync(`${WORKSPACE}/named.txt`, 'kept\n')
  let stdout = ''
  const argvCode = await new Promise<number>((settle) => {
    startProcess({
      argv: ['cat', 'named.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      onOutput(_stream, text) { stdout += text },
      onExit: settle,
    })
  })
  expect({ code: argvCode, stdout }).toEqual({ code: 0, stdout: 'kept\n' })
})

it('inline interrupt asks the command to stop', async () => {
  const exits: number[] = []
  const running = startProcess({
    script: 'sleep 30',
    argv: ['bash', '-c', 'sleep 30'],
    cwd: WORKSPACE,
    env: {},
    stdin: '',
    onOutput() {},
    onExit(code) { exits.push(code) },
  })
  running.interrupt()
  await vi.waitFor(() => { expect(exits).toEqual([130]) })
})

it('inline argv and script runs settle without a Worker constructor', async () => {
  vfs.writeFileSync(`${WORKSPACE}/named.txt`, 'kept\n')
  let stdout = ''
  const argvCode = await new Promise<number>((settle) => {
    startProcess({
      argv: ['cat', 'named.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      onOutput(_stream, text) { stdout += text },
      onExit: settle,
    })
  })
  expect({ code: argvCode, stdout }).toEqual({ code: 0, stdout: 'kept\n' })

  const script = await new Promise<{ code: number; stdout: string }>((settle) => {
    let out = ''
    startProcess({
      script: 'echo hi',
      argv: ['bash', '-c', 'echo hi'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      onOutput(_stream, text) { out += text },
      onExit(code) { settle({ code, stdout: out }) },
    })
  })
  expect(script).toEqual({ code: 0, stdout: 'hi\n' })
})

it('Worker with a non-text location href runs inline', async () => {
  vi.stubGlobal('Worker', LoopbackWorker)
  vi.stubGlobal('self', { location: { href: 1 } })
  const code = await new Promise<number>((settle) => {
    startProcess({
      script: 'true',
      argv: ['bash', '-c', 'true'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      onOutput() {},
      onExit: settle,
    })
  })
  expect(code).toBe(0)
  expect(started).toHaveLength(0)
})

it('reaches every filesystem op and appends through the worker frames', async () => {
  stubWorker()
  let stdout = ''
  const code = await new Promise<number>((settle) => {
    startProcess({
      script: 'mkdir -p nested && echo a > nested/file.txt && echo b >> nested/file.txt && ls nested && mv nested/file.txt nested/moved.txt && cat nested/moved.txt && rm nested/moved.txt',
      argv: ['bash', '-c', 'mkdir -p nested && echo a > nested/file.txt && echo b >> nested/file.txt && ls nested && mv nested/file.txt nested/moved.txt && cat nested/moved.txt && rm nested/moved.txt'],
      cwd: WORKSPACE,
      env: {},
      stdin: '',
      onOutput(stream, text) {
        if (stream === 'stdout') stdout += text
      },
      onExit: settle,
    })
  })
  expect(code).toBe(0)
  expect(stdout).toBe('file.txt\na\nb\n')
  expect(started[0]?.moduleWorker).toBe(true)
  expect(started[0]?.childClosed).toBe(true)
})
