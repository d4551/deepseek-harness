# Agent Note: Settings service write and disposal integrity

Status: implemented

English | [中文](2026-09-01-settings-service-write-and-disposal-integrity.zh.md)

## Problem

Three markers in `packages/settings/settings/src/index.ts` named three separate ways the service could report a value that storage did not hold.

`TODO(settings-json-properties)` covered two sites that rebuild a document with plain assignment. `cloneJsonShaped` wrote `out[key] = ...` and `mergeLayers` wrote `merged[key] = ...`. `__proto__` is an ordinary key in a JSON document, but plain assignment routes it through the inherited `Object.prototype.__proto__` setter, so the entry never becomes own data. `mergeLayers` also asked `key in merged`, which consults the prototype chain, so a key named `toString` or `constructor` read as already present and took the merge path rather than the assign path.

`TODO(settings-registration-quiescence)` covered the registration disposer, which ran `this.registrations.delete(ns)` and returned. A watcher registered through that scope kept `active: true` and its queued tail kept running, so a callback owned by a fiber could execute after that fiber unloaded. The per-watcher disposer already deactivated one watcher; nothing did it for the registration as a whole.

`TODO(settings-replacement-resync)` covered the write queue's commit step. A queued write reads the section at the front of the queue, persists, then commits only `if (this.registrations.get(ns) === registration)`. When the original registrant is disposed mid-persist and a replacement registers the same namespace, that guard is false, so the write landed in storage and the new owner was never told. The replacement had resolved from the section as it stood before the write, and kept that value indefinitely.

## Decision

**Document keys are stored as own data.** A `defineOwn` helper writes through `Object.defineProperty` with a writable, enumerable, configurable descriptor, and both rebuild sites use it. `mergeLayers` tests presence with `Object.hasOwn` instead of `in`, so an inherited method name is an absent key rather than a merge target.

**Disposal reaches quiescence.** The registration disposer is async. It deletes the registry entry, deactivates every watcher the registration owns, clears the set, and then awaits the captured tails. The order is the one [defensive patterns](../../../../docs/defensive-patterns.md) states: close the notification registry first so a queued invocation reads `active` at its start and returns silently, then await the started ones so no callback outlives the registrant fiber.

**A persisted write always reaches whoever owns the namespace.** The commit step resolves the current owner once. When the owner is the writer, it commits as before. When a replacement owns the namespace, it re-resolves that replacement against its own schema from the section that actually reached storage and commits that. A section the replacement's schema rejects keeps its last good value and warns, matching how `publish` already handles an invalid stored section.

## Alternatives considered

**`Object.create(null)` for rebuilt objects.** Removes the setter hazard by removing the prototype. Rejected: it changes every consumer that calls a prototype method on a resolved settings value, a much wider behavior change than the defect requires, and it would make resolved values print and compare differently.

**A synchronous registration disposer that only deactivates watchers.** Stops new invocations but returns while a started callback is still running, which is the orphan the quiescence rule names.

**Letting the replacement re-read on its own.** A replacement cannot know a write was in flight when it registered, so the read would have to be a poll or an unconditional re-resolve on every registration. The writer already holds the persisted section and the owner lookup, so it commits from there.

## Consequences

- A document key named `__proto__` round-trips through a write and appears in the `user` layer that `describe()` reports.
- A registrant fiber's `dispose()` settles only after its watcher callbacks finish; a caller awaiting disposal now waits for them.
- A replacement registration receives a `settings/updated` commit and a revision bump for a write that was in flight when it took the namespace.
- The schema layer below the service rebuilt with plain assignment and lost the key on the way back out, so `vendor/schemastery` carries a matching own-property construction change, logged as local modification 20 in [vendor/README.md](../../../../vendor/README.md).

## Testing

`packages/settings/settings/tests/settings.spec.ts` adds three groups. Prototype-colliding keys: a write records `__proto__` as own data in the persisted section, the reported `user` layer keeps it own with an unchanged prototype, and an inherited method name resolves as a plain key. Disposal quiescence: disposal stays pending while a started callback blocks and settles after it finishes, and an invocation still queued when disposal begins never runs. Replacement resync: a replacement that takes the namespace during a held `persist` re-resolves from the persisted section, and one whose schema rejects that section keeps its last good value and warns. Each of the three fixes was reverted in place and the matching test observed to fail before the fix was restored. The file holds per-file 100% statements, branches, functions, and lines.
