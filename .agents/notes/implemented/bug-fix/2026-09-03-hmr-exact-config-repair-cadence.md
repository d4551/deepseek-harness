# Agent Note: An exact config watch repairs what the platform watch never reported

Status: implemented

English | [中文](2026-09-03-hmr-exact-config-repair-cadence.zh.md)

## Problem

`Hmr.registerConfig(filename, refresh)` had one trigger: Chokidar's `add`, `change`, and `unlink` on the watched path. Chokidar reports `ready` once its initial scan finished and `fs.watch()` returned, and on macOS libuv arms the FSEvents stream on its own CoreFoundation run-loop thread after that call returns. A change landing between the finished scan and the armed stream is in neither, produces no event, and is lost for good — so the registered callback disagreed with the file until some later change happened to be reported.

[The user-patch note](2026-09-03-user-patch-watch-readiness.md) closed this for `watchUserPatches` by giving that consumer a second trigger, and recorded that the seam itself kept the window: "Every other consumer of it keeps the window, `hmr-config.spec.ts` included." That is what was still live. `packages/boot/app-boot/tests/hmr-config.spec.ts` calls `registerConfig` directly and imports nothing from `app-boot/src`, so the consumer-level fix could not reach it. Under CPU load it failed at 2 runs in 20, as `HMR did not observe config creation` and `HMR did not observe config creation under a new parent`:

```
FAIL  packages/boot/app-boot/tests/hmr-config.spec.ts > HMR exact config paths >
      observes creation when the config parent did not exist at registration
Error: HMR did not observe config creation under a new parent
 ❯ eventually packages/boot/app-boot/tests/hmr-config.spec.ts:29:39
```

Measured at the seam rather than through the suite: rounds that register a config path and create the file in the turn after registration resolves lost 6 of 810 on a loaded 18-core host, across three batches of 10, 300, and 500. Repeating the largest batch with the cadence in place lost 0 of 500 under heavier load. The losses are the arming window, not a Chokidar filter — the sibling note's instrumentation shows the watcher emitting `ready` with no `raw` line ever following it.

## Decision

A filesystem event is no longer the only trigger. `registerConfig` runs a repair cadence every `repairInterval` milliseconds — a new `Hmr.Config` field, `z.natural().role('ms').default(100)`, where `0` runs the watch alone — and both triggers share the existing serialized `refreshConfig` queue through one reconciliation that announces each generation exactly once:

- A generation is the SHA-256 of the file's content, `absent` when the path does not exist, and `error:<code>` when it is present and unreadable. Content, not stat metadata: a filesystem whose timestamps have one-second resolution reports the same mtime and size for two writes of equal length, which is an ordinary config edit, and a poll's own first stat is a baseline it never reports — the same defect one layer down.
- The read is synchronous, so a writer on this thread cannot be observed between its truncation and its write. The alternative samples a torn zero-byte generation and announces it.
- The seed is the absent generation, which is what `ignoreInitial: false` already promises: a file present at registration is announced once, an absent one not at all.
- The generation is recorded before the callback runs, so a generation whose refresh throws is reported once — through `hmr/config-update-failed`, unchanged — no matter which trigger observed it, and a path that stays unreadable is not re-reported every tick.
- Registration disposal and `Service.init` teardown clear the cadence before draining the queue, so nothing new enters it. The timer is `unref`ed: a repair cadence must never be why a finished process stays alive.

The callback therefore trails its file by at most one `repairInterval` whatever the platform watch loses, and never sees one generation twice. The watch remains the fast path and is otherwise untouched.

`hmr-config.spec.ts` pins the cadence directly rather than by racing it: one case registers a watch that cannot report inside its own lifetime — Chokidar polling a minute apart, whose initial scan of an empty directory is its only delivery — and asserts that a creation, a same-length change, and a removal each reach the callback exactly once. Two existing cases tightened from a de-duplicated assertion to the exact announcement sequence, which is now the guarantee, and the failure case dropped the 250 ms wait it held for Chokidar's per-path change throttle: an event the throttle drops is a generation the cadence announces like any other one no event reported.

## Alternatives considered

**Prove the watch is armed before returning.** The proof has to be a change the watcher itself reports, and `registerConfig` roots its watcher at the deepest existing ancestor — for a profile directory that does not exist yet, that is the Harness home or the user's home. A probe would either create the caller's own config file or leave a stray file in the user's home when a process is killed mid-boot. The sibling note rejected this for the same reason one layer up.

**Fingerprint `stat` instead of content.** One stat per tick instead of one read, and it is what a polling watcher compares. It misses two writes of equal length inside one filesystem timestamp tick, which on a one-second-resolution filesystem is an ordinary edit — the exact class of loss this cadence exists to catch. The cost it saves is one read of one config file per 100 ms.

**Leave the seam alone now that `watchUserPatches` repairs its own file.** That fix covers one path in one consumer. `registerConfig` is a published seam method whose readiness contract reads stronger than it is, and its coverage lives in a suite that does not go through the consumer at all. Repairing at the seam makes every present and future caller correct, and the consumer's own cadence stays: it dedupes by applied text, so the extra trigger reconciles to nothing.

**Stop the cadence once the watch delivers its first event.** It bounds the cost to the arming window, which is where this defect was measured. It also assumes the arming window is the only loss, and FSEvents coalescing, a network filesystem, and Chokidar's own change throttle all drop events long after arming. A permanent cadence is one behavior with one stated bound instead of two behaviors with a handover between them.

**Switch the exact watch to `usePolling`.** Chokidar's polling backend takes its first stat as a baseline it never reports, so a file created between the scan and that stat is missed exactly as the native watch misses it, and every change then costs a poll interval.

## Consequences

One read of one config file every 100 ms per registered path, for the lifetime of the registration, in exchange for a bound on how long a callback may trail its file. A deployment on a lossier or more expensive filesystem moves `repairInterval`; `0` restores the platform's own losses.

`dsh` now reads a profile's `cordis.patch.yml` twice per 100 ms — once for this cadence, once for the consumer's. Both reconcile an unchanged file to nothing, and the consumer's cadence is what covers the case where the seam is stubbed.

The vendored divergence is logged as entry 21 in [vendor/README.md](../../../../vendor/README.md), so the next upstream sync re-applies or retires it deliberately.

The seam's readiness contract is unchanged: `registerConfig` still reports ready when Chokidar does. What changed is that readiness is no longer load-bearing — a callback that misses the arming window is repaired instead of stranded.

The ordinary HMR watcher's config-refresh path (`refreshConfig(include, …)`) is untouched and keeps the window. It watches module roots with `ignoreInitial: true`, its file was already applied by boot, and its generation belongs to the Include that owns the file.
