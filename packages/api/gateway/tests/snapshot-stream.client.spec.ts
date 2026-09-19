import { describe, expect, it, vi } from 'vitest'
import {
  RemoteSnapshotStream,
  RemoteStream,
  RemoteStreamCarrierError,
  type RemoteSnapshotStreamOptions,
  type RemoteStreamOptions,
} from '../src/client/index.ts'

interface Snapshot {
  readonly kind: 'snapshot'
  readonly id: number
}

interface Delta {
  readonly kind: 'delta'
  readonly id: number
}

type Frame = Snapshot | Delta

const AVAILABLE_CONNECTION = {
  generation: {
    getSnapshot: () => ({ id: 1, host: { home: '/home/fixture' } }),
    subscribe: () => () => {},
  },
}

function snapshot(id: number): Snapshot {
  return { kind: 'snapshot', id }
}

function delta(id: number): Delta {
  return { kind: 'delta', id }
}

class HeldDisposeStream extends RemoteStream<Frame> {
  private readonly releaseDispose = Promise.withResolvers<undefined>()

  /** Allow the snapshot consumer to refuse after disposal has begun. */
  release(): void {
    this.releaseDispose.resolve(undefined)
  }

  /** @inheritdoc */
  override dispose(): Promise<void> {
    return this.releaseDispose.promise.then(() => super.dispose())
  }
}

function snapshotOptions(
  replaced: Snapshot[],
  updated: Delta[],
  failed: (error: unknown) => void,
): RemoteSnapshotStreamOptions<Snapshot, Delta> {
  return {
    name: 'fixture snapshot',
    isSnapshot: (value): value is Snapshot => value.kind === 'snapshot',
    replace: (value) => { replaced.push(value) },
    update: (value) => { updated.push(value) },
    failed,
  }
}

function remoteOptions(
  open: (signal: AbortSignal) => AsyncIterable<Frame>,
): RemoteStreamOptions<Frame> {
  return {
    name: 'fixture snapshot',
    open,
    ended: accepted => accepted
      ? new RemoteStreamCarrierError('fixture snapshot ended without a terminal result')
      : new Error('fixture snapshot ended before its opening snapshot'),
  }
}

function snapshotStream(
  open: (signal: AbortSignal) => AsyncIterable<Frame>,
): {
  readonly stream: RemoteSnapshotStream<Snapshot, Delta>
  readonly replaced: Snapshot[]
  readonly updated: Delta[]
  readonly failed: ReturnType<typeof vi.fn<(error: unknown) => void>>
} {
  const replaced: Snapshot[] = []
  const updated: Delta[] = []
  const failed = vi.fn<(error: unknown) => void>()
  const stream = new RemoteSnapshotStream(
    new RemoteStream(AVAILABLE_CONNECTION, remoteOptions(open)),
    snapshotOptions(replaced, updated, failed),
  )
  return { stream, replaced, updated, failed }
}

describe('RemoteSnapshotStream', () => {
  it('replaces the opening snapshot, applies later deltas, and ignores a second start', async () => {
    const fixture = snapshotStream(async function* (signal) {
      yield snapshot(1)
      yield delta(2)
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
    })

    fixture.stream.start()
    fixture.stream.start()
    await vi.waitFor(() => { expect(fixture.updated).toEqual([delta(2)]) })
    expect(fixture.replaced).toEqual([snapshot(1)])
    expect(fixture.failed).not.toHaveBeenCalled()
    fixture.stream.restart()
    await fixture.stream.dispose()
  })

  it('replaces a later generation after a leftover carrier loss', async () => {
    let opened = 0
    const fixture = snapshotStream(async function* (signal) {
      opened += 1
      if (opened === 1) {
        yield snapshot(1)
        yield delta(2)
        throw new RemoteStreamCarrierError('carrier lost')
      }
      yield snapshot(3)
      yield delta(4)
      if (!signal.aborted) {
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => { resolve() }, { once: true })
        })
      }
    })

    fixture.stream.start()
    await vi.waitFor(() => { expect(fixture.updated).toEqual([delta(2), delta(4)]) })
    expect(fixture.replaced).toEqual([snapshot(1), snapshot(3)])
    expect(fixture.failed).not.toHaveBeenCalled()
    await fixture.stream.dispose()
  })

  it('publishes a leftover follow refusal after the opening snapshot', async () => {
    const fixture = snapshotStream(async function* () {
      yield snapshot(1)
      throw 'leftover string'
    })

    fixture.stream.start()
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toBe('leftover string')
    expect(fixture.replaced).toEqual([snapshot(1)])
    await fixture.stream.dispose()
  })

  it('reports a second opening snapshot in one generation', async () => {
    const fixture = snapshotStream(async function* () {
      yield snapshot(1)
      yield snapshot(2)
    })

    fixture.stream.start()
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture snapshot emitted more than one opening snapshot',
    })
    expect(fixture.replaced).toEqual([snapshot(1)])
    await fixture.stream.dispose()
  })

  it('reports a delta before its opening snapshot', async () => {
    const fixture = snapshotStream(async function* () {
      yield delta(1)
    })

    fixture.stream.start()
    await vi.waitFor(() => { expect(fixture.failed).toHaveBeenCalledOnce() })
    expect(fixture.failed.mock.calls[0]?.[0]).toMatchObject({
      message: 'fixture snapshot emitted an update before its opening snapshot',
    })
    expect(fixture.replaced).toEqual([])
    await fixture.stream.dispose()
  })

  it('suppresses a leftover consumer refusal after disposal begins', async () => {
    const hold = Promise.withResolvers<undefined>()
    const replaced: Snapshot[] = []
    const updated: Delta[] = []
    const failed = vi.fn<(error: unknown) => void>()
    let refused = false
    const remote = new HeldDisposeStream(AVAILABLE_CONNECTION, remoteOptions(async function* () {
      yield snapshot(1)
      await hold.promise
      refused = true
      throw 'leftover after dispose'
    }))
    const stream = new RemoteSnapshotStream(remote, snapshotOptions(replaced, updated, failed))

    stream.start()
    await vi.waitFor(() => { expect(replaced).toEqual([snapshot(1)]) })
    const closing = stream.dispose()
    hold.resolve(undefined)
    await vi.waitFor(() => { expect(refused).toBe(true) })
    await Promise.resolve()
    await Promise.resolve()
    remote.release()
    await closing
    expect(failed).not.toHaveBeenCalled()
  })

  it('disposes before start without starting a consumer', async () => {
    const fixture = snapshotStream(async function* () {
      yield snapshot(1)
    })

    await fixture.stream.dispose()
    expect(fixture.replaced).toEqual([])
    expect(fixture.failed).not.toHaveBeenCalled()
  })
})
