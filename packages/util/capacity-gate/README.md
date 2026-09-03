---
description: "Zero-dependency bounded FIFO admission control for capability holders that cap concurrent work without coupling the settlement of the operations they admit."
kind: "package-reference"
---

# @deepseek-ai/dsh-capacity-gate

English | [中文](README.zh.md)

## Summary

`dsh-capacity-gate` bounds how many operations one holder runs at once. A caller takes a slot with `acquire()`, runs its work, and returns the slot through the idempotent release the gate handed back. Callers that arrive while the gate is full queue in arrival order and are admitted first-in, first-out. The gate only delays an acquisition: it never cancels, settles, or cleans up the admitted work, so two operations sharing one gate keep independent settlement. Cancellation has two scopes — a per-acquisition `AbortSignal` rejects that one waiter and leaves it holding nothing, while `close(error)` rejects every queued waiter and refuses later acquisitions so a disposing holder never leaves a caller parked forever.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Construct one gate per holder from a validated deployment limit, then bracket each admitted operation with the release the gate returns.

```ts
import { CapacityGate } from '@deepseek-ai/dsh-capacity-gate'

declare const maxConcurrent: number
declare const signal: AbortSignal
declare function runWork(): Promise<string>

const gate = new CapacityGate(maxConcurrent)

const release = await gate.acquire(signal)
try {
  const outcome = await runWork()
  void outcome
} finally {
  release()
}
```

`acquire` resolves as soon as a slot is free and otherwise queues. `signal` governs the wait alone: below the bound the gate grants without reading it, so a holder that is not saturated behaves exactly as it would with no gate and keeps its own pre-flight cancellation rule. Once the gate is full, a caller that has already aborted or aborts while queued rejects with `signal.reason` and holds no slot. The release is idempotent, so a holder that must release from several terminal paths — a rejection before the work starts, the work's own settlement, and an explicit disposal — may call it from each.

### Disposing a holder

```ts
import { CapacityGate } from '@deepseek-ai/dsh-capacity-gate'

declare const gate: CapacityGate

gate.close(new Error('holder disposed before the slot was granted'))
```

`close` rejects every queued waiter with that error and makes later `acquire` calls reject with it too. Slots already granted stay with their holders, whose releases remain safe.

### Keeping the unsaturated path unchanged

```ts
import { CapacityGate } from '@deepseek-ai/dsh-capacity-gate'

declare const gate: CapacityGate
declare const signal: AbortSignal

const release = gate.tryAcquire() ?? await gate.acquire(signal)
```

`tryAcquire()` takes a slot only while the gate is below its bound and yields to nothing, returning `undefined` when the gate is full or closed. A holder whose callee must run in the caller's own tick — a provider that installs an abort listener during its own start, for instance — takes this path first, so adding the gate changes nothing until the bound actually binds.

### Observing admission

`snapshot()` returns `{ limit, active, waiting }`: the configured bound, the grants not yet released, and the queue length. A holder exposes it when deployments need to see whether work is running or parked.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `CapacityGate` (`tryAcquire`, `acquire`, `close`, `snapshot`), `CapacityRelease`, `CapacitySnapshot` |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; the queue algebra is exercised by unit tests) |

### Why the grant races the abort

A release grants the head waiter synchronously, while the granted caller resumes one microtask later. An abort that lands in that window finds its waiter already out of the queue, so the post-grant check re-reads the signal, hands the slot to the next waiter, and throws. That keeps the promise "a cancelled acquisition never runs work under a slot" true without leaking the slot the release had already handed over.

### Counting versus queueing

The gate reserves slots itself rather than deriving a count from the holder's own records. A holder whose cap is a refusal instead of a wait — reject the request when the count is at the limit — needs no queue and does not use this package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Subagent seam](../../subagent/subagent/README.md) — bounds concurrent one-shot child runs with this gate.
- [Worker-thread workflow engine](../../workflow/workflow-worker-thread/README.md) — bounds concurrent `agent()` calls inside one script run.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the holders that admit model-facing work, where a delayed admission shows up only as the latency of the tool call it waits inside.

#### KV Cache effect

None: the gate contributes no prompt text and reorders no request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Admission only** — the gate delays a start and never stops admitted work; every holder still owns cancellation and cleanup for the operation it ran under the slot.
- **A free slot ignores the signal** — cancellation is checked only when the caller must wait, so a holder still needs its own pre-flight check for the unsaturated path.
- **One flat queue per gate** — there is no priority, fairness class, or per-owner sub-quota; a holder that needs those composes several gates.
- **The limit is fixed at construction** — a deployment that changes its bound rebuilds the holder rather than resizing a live gate.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
