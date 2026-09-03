---
description: "Zero-dependency per-key operation serialization for filesystem backends that must not interleave two mutations of one target."
kind: "package-reference"
---

# @deepseek-ai/dsh-keyed-lock

English | [中文](README.zh.md)

## Summary

One operation runs per key at a time and later callers for that key queue behind it in arrival order, while different keys run concurrently. It exists because every `ctx.fs` backend needs that guarantee and each had written it: `fs-local`, `fs-e2b`, and `fs-network-drive` held three copies of the same promise-chain algebra. Queues are created on first use and dropped when they drain, so a process that touches many keys once retains nothing.

## Table of Contents

- [Use this package](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Per-key operation serialization. One operation runs per key at a time; later callers for that key queue behind it in arrival order, while different keys run concurrently.

## Why it exists

A filesystem backend must not run two mutations against one target at once: a read-modify-write pair that interleaves loses one of the two writes. Every `ctx.fs` backend needs that guarantee, and each had written it — `fs-local`, `fs-e2b`, and `fs-network-drive` held three copies of the same promise-chain algebra. One owner replaces them.

## Use

```ts
import { KeyedLock } from '@deepseek-ai/dsh-keyed-lock'

declare const targetKey: string
declare function read(key: string): Promise<string>
declare function edit(current: string): string
declare function write(key: string, next: string): Promise<string>

const locks = new KeyedLock()
const version = await locks.run(targetKey, async () => {
  const current = await read(targetKey)
  return write(targetKey, edit(current))
})
```

`run(key, operation)` resolves or rejects with exactly what `operation` produced. A rejection reaches only its own caller: the next operation queued for that key still runs, so one failed write does not stall the key.

Queues are created on first use and dropped when they drain, so a process that touches many keys once retains nothing. `size` reports how many keys currently hold an operation, which is what the package's tests assert against.

## Model Experience

Indirectly, through the filesystem backends that serialize their writes, where a queued operation shows up only as the latency of the tool call waiting behind an earlier write to the same file.

#### KV Cache effect

None: the lock contributes no prompt text and reorders no request.


## Known Limitations and Deferred Work
- **Keys are strings compared exactly.** Two spellings of one path are two keys. Callers that need path identity canonicalize before locking; `dsh-fs` backends pass the branded `FsTargetKey` their own `resolve()` minted, which is already canonical.
- **No timeout, no cancellation, and no reentrancy.** A caller that never settles holds its key forever, and an operation that calls `run` again for the key it already holds deadlocks. Both are properties of the callers this serves, where each operation is a bounded filesystem write; a queue that needed to be abandoned would need a different primitive.
- **No fairness beyond arrival order.** There is no priority, and a key under continuous load serves callers in the order they arrived rather than by any weighting.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
