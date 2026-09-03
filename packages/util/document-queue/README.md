---
description: "One file-backed document's exclusive operation chain: serialized in-process operations, watcher-driven reloads with a warn-and-keep policy, and quiescent disposal."
kind: "package-reference"
---

# @deepseek-ai/dsh-document-queue

English | [中文](README.zh.md)

## Summary

`dsh-document-queue` owns the plumbing every provider that stores one document under the harness home needs, whatever that document holds. Writes and reloads run one at a time on a single chain, so a render never starts from text a concurrent reload is replacing. A filesystem watcher turns an external edit into a queued reload and closes the startup gap in which a change written between the owner's first read and the watcher becoming active fires no event. Disposal is quiescent: the queue refuses new work, stops the watcher, and resolves only once every queued operation has settled. Reading, parsing, validating, rendering, and publishing stay with the owner — the queue calls the owner's `reconcile` step and applies one failure policy to it.

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

Resolve the document location once, construct one queue for it, and run every operation through the queue.

```ts
import { DocumentQueue, readDocumentText, resolveDocumentSpec } from '@deepseek-ai/dsh-document-queue'
import type { Context } from '@deepseek-ai/cordis'

declare const ctx: Context
declare const config: { path?: string; dshHome?: string; watch?: boolean; debounceMs?: number }
declare function publish(text: string | undefined): void

const spec = resolveDocumentSpec(config, 'settings.yaml')
let cached: string | undefined

const reconcile = async (): Promise<void> => {
  const text = await readDocumentText(spec.filename)
  if (text === cached || queue.isClosed()) return
  cached = text
  publish(text)
}

const queue = new DocumentQueue({
  label: 'settings-file',
  filename: spec.filename,
  debounceMs: spec.debounceMs,
  logger: ctx.logger,
  reconcile,
})
```

`resolveDocumentSpec(config, basename)` is the one defaulting step: an explicit `path` wins, otherwise the document sits at `<harness home>/<basename>`, watching defaults to on, and the write-settle window defaults to 100ms. A caller whose config carries extra fields passes the same object; only these four are read.

A plugin entry validates the same four keys with `static Config: z<Config> = z.object(DocumentQueueConfigFields)`, so the Loader schema and `resolveDocumentSpec`'s defaults never drift apart. Each provider still declares its own `Config` interface — that declaration is what the [config catalog](../../../docs/config-catalog.md) pastes as the plugin's deployment surface, and the catalog generator follows the field reference one hop into this package.

### Serializing a write

```ts
import { DocumentQueue } from '@deepseek-ai/dsh-document-queue'

declare const queue: DocumentQueue
declare function renderAndCommit(): Promise<void>

await queue.enqueue(async () => {
  if (queue.isClosed()) throw new Error('provider is disposed: cannot write')
  await renderAndCommit()
})
```

`enqueue` runs operations in arrival order and always settles its tail, so a rejected operation neither stalls the next one nor leaks its rejection into it. The rejection still reaches its own caller unchanged. Entry checks belong at both ends: reject early, and re-judge inside the operation, because the state may have changed while the operation waited.

### Watching and disposing

```ts
import { DocumentQueue } from '@deepseek-ai/dsh-document-queue'

declare const queue: DocumentQueue
declare const watchConfigured: boolean

if (watchConfigured) await queue.watch()

await queue.close()
```

The `close()` call belongs on the owner's disposal path. `watch()` installs a chokidar watcher on the canonicalized path with `awaitWriteFinish` sized by `debounceMs`, queues a reload for every change, and queues one more when the watcher reports ready. `close()` is safe to call repeatedly and from several teardown paths; each call waits for the same tail.

### The reload failure policy

`queueReload()` (also what the watcher calls) runs the owner's `reconcile` and splits its failures: an error carrying `code === 'INVARIANT'` propagates and is reported through `logger.error`, because a poisoned commit is not a reload problem; every other failure is reported through `logger.warn` and leaves the owner's last good snapshot in place, because a live hot reload must not take the process down. A caller that wants the opposite — fail loud — calls `reconcile` itself inside `enqueue`, which is what a read-modify-write does before rendering.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `DocumentQueue`, `resolveDocumentSpec`, `readDocumentText`, `isENOENT`, and their types |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; each queue is private to its owner) |

### Why the chain is one settled tail

`enqueue` chains onto a tail that absorbs both outcomes, so the queue never rejects itself and the next operation runs regardless of what the previous one did. `close()` awaits that same tail, which is why a disposing owner can be sure no queued write is still able to publish: the tail resolves only after the last operation settles.

### Why absence is a value

`readDocumentText` returns `undefined` for a missing file and rethrows every other error. An owner that treated any read failure as absence would publish an empty store the moment a document became unreadable, which is indistinguishable from a user deleting every entry.

### What stays with the owner

The queue never opens the document for content. Permission checks, format detection, parsing, comment-preserving rendering, the cross-process writer lock, and seam publication all belong to the owning provider, because each is specific to what the document holds.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [File-backed settings provider](../../settings/settings-file/README.md) — one YAML or JSON document of namespace sections on this queue.
- [File-backed credentials provider](../../credentials/credentials-local/README.md) — the harness-home credentials document on this queue.
- [Atomic write](../atomic-write/README.md) — the durable commit and cross-process writer lock those providers use inside a queued operation.

-----

<a id="model-experience"></a>
## Model Experience

None, as this package contributes no model-visible text, tool, or prompt: it serializes a provider's own filesystem work, and a model only ever sees whatever that provider chooses to publish.

#### KV Cache effect

None: the queue contributes no request tokens and reorders no model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **One document per queue** — the chain is global to the queue, so an owner storing several documents constructs several queues and gets no cross-document ordering.
- **No cross-process serialization** — the chain orders this process's operations only; a writer that must exclude another process still takes the file lock from `dsh-atomic-write` inside its queued operation.
- **A missed watcher event stays unseen** — the queue reconciles on watcher events and at watcher ready, never on a timer, so a change the platform watcher fails to report is folded in only by the next event, the next queued operation, or a restart.
- **The reload policy is fixed** — `INVARIANT` propagates and everything else warns; an owner that needs a different split calls `reconcile` inside `enqueue` and applies its own.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
