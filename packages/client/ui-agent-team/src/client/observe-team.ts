/** Bounded consumption of Team invalidations and authoritative view reads. */

type ActivityEdge =
  | { type: 'change'; result: IteratorResult<number> }
  | { type: 'read' }

/**
 * Drain activity independently of view latency, retaining one pending refresh.
 * @param changes - generated Remote activity source.
 * @param refresh - authoritative view read and publication.
 * @param signal - panel subscription cancellation.
 */
export async function observeTeamActivity(
  changes: (signal: AbortSignal) => AsyncIterable<number>,
  refresh: () => Promise<boolean>,
  signal: AbortSignal,
): Promise<void> {
  const controller = new AbortController()
  const subscriptionSignal = AbortSignal.any([signal, controller.signal])
  let iterator: AsyncIterator<number> | undefined
  let next: Promise<ActivityEdge> | undefined
  let read: Promise<ActivityEdge> | undefined
  let dirty = false
  const consume = async (): Promise<void> => {
    subscriptionSignal.throwIfAborted()
    const stream = changes(subscriptionSignal)[Symbol.asyncIterator]()
    iterator = stream
    const advance = async (): Promise<ActivityEdge> => ({ type: 'change', result: await stream.next() })
    next = advance()
    while (!subscriptionSignal.aborted) {
      const edge = read === undefined ? await next : await Promise.race([next, read])
      subscriptionSignal.throwIfAborted()
      if (edge.type === 'change') {
        if (edge.result.done) return
        if (!Number.isSafeInteger(edge.result.value) || edge.result.value < 0) {
          throw new Error('Invalid Agent Teams activity revision')
        }
        dirty = true
        next = advance()
      } else {
        read = undefined
      }
      if (dirty && read === undefined) {
        dirty = false
        read = refresh().then((): ActivityEdge => ({ type: 'read' }))
      }
    }
  }
  const [outcome] = await Promise.allSettled([consume()])
  controller.abort()
  const close = async (): Promise<void> => { await iterator?.return?.() }
  const cleanup = await Promise.allSettled([next, read, close()])
  const failures = new Set<unknown>()
  if (outcome.status === 'rejected') failures.add(outcome.reason)
  for (const result of cleanup) {
    if (result.status === 'rejected' && result.reason !== subscriptionSignal.reason) {
      failures.add(result.reason)
    }
  }
  if (failures.size === 1) {
    for (const failure of failures) throw failure
  }
  if (failures.size > 1) throw new AggregateError(failures, 'Team activity and cleanup failed')
}
