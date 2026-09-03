# Agent Note: A watcher that reports ready is not yet a watcher that reports changes

Status: implemented

English | [中文](2026-09-03-user-patch-watch-readiness.zh.md)

## Problem

`watchUserPatches` registered one trigger — an HMR exact-path watch — and treated Chokidar's `ready` event as the moment the user patch layer became live. `ready` fires once Chokidar's initial scan finished and `fs.watch()` returned. On macOS `fs.watch()` returning is not the same as the platform watch observing changes: libuv hands the path to its CoreFoundation run-loop thread and arms the FSEvents stream there, after the call returns. A change that lands between the scan (which is over) and the armed stream (which has not started) produces no event at all, and because the initial scan is the only other observation, the mounted layer then disagreed with the file until some later change happened to be reported.

`packages/boot/app-boot/tests/user-patches.spec.ts` :: `watches add, failure, recovery, and removal through transactional HMR` sat exactly in that window: it wrote the patch file in the turn after `watchUserPatches` resolved, then waited 10 s for the layer to change. It failed as `user patch addition was not applied` at roughly one run in twelve on a loaded 18-core host, and far more often when the machine was busier — CPU pressure delays the run-loop thread, which widens the window.

Instrumenting the registration's `FSWatcher` showed the loss is below Chokidar rather than a filter or a throttle. Every event the watcher emitted on a failing round, including its `raw` re-emission of each `fs.watch` callback:

```
addDir:/private/var/folders/…/T/dsh-diag-WIn6P9
THROTTLE:readdir:dsh-diag-WIn6P9:1000:ok
ready:undefined
```

No `raw` line ever follows, so `fs.watch` never called back and the registered refresh never ran. A passing round carries `RAW:rename:cordis.patch.yml` and then the `add`. The same shape reproduces with no Harness code at all: 200 iterations of `fs.watch(dir)` immediately followed by one `writeFileSync` lose the event once; under load the Harness path lost 3 in 200.

Nothing available to this package can close the window by waiting. Chokidar's `ready` is the strongest readiness signal the library offers, arming is not observable from `watchUserPatches` (the callback it registers only fires for the watched path, so a probe would have to create the user's own config file), and a stat poll has the same defect one layer down: `fs.watchFile` records its baseline on its own first stat and reports nothing for a file created before it.

## Decision

A filesystem event is no longer the only trigger. `watchUserPatches` also reconciles on `repairInterval` — 100 ms unless the caller names another — and both triggers share one reconciliation that reads the file and applies each generation of its text exactly once:

- The generation the mounted tree reflects is seeded from the file at registration, because `boot()` applied that same content before the call. An unchanged file therefore costs one read per tick and no tree update.
- The generation is recorded before it is attempted, so a broken file is applied and reported once no matter which trigger observed it, and a read failure is deduplicated by its message so a file that stays unreadable is not re-reported every tick.
- Reconciliations run on one promise chain. Two `entry.update()` calls in flight interleave candidate application and rollback on one Include tree, and the two triggers observe the same file.
- The repair trigger reports its own failures through `hmr/config-update-failed`, the event HMR broadcasts for the watch trigger, so one broken file reads the same either way. Its own observers' rejections are contained.
- The cadence is a `ctx.effect`, so tree disposal stops it — `apps/cli/src/profile-boot.ts` discards the returned disposer and relies on that. Its timer is `unref`ed: a repair cadence must never be why a finished process stays alive. The returned disposer stops both triggers before draining the chain.

The bound this buys is explicit: the mounted layer may disagree with the file for at most one `repairInterval`, whatever the platform watch loses. The watch trigger remains the fast path and is untouched.

`settleChokidarChangeThrottle()` — a 75 ms sleep the suite held between generations — is gone. It existed for Chokidar's separate 50 ms per-path `change` throttle, which silently drops a second write inside that window; with a repair cadence a throttled-away event is repaired like any other undelivered one. Reverting the source and keeping the deletion fails the case at `parse failure was not broadcast`, which is that throttle.

## Alternatives considered

**Prove the watch is armed before returning.** This is the direct reading of "make readiness real", and the proof has to be a change the watcher itself reports. `watchUserPatches` only ever hears about the watched path, so the probe would be the user's own `cordis.patch.yml` — creating and deleting the file it is supposed to be observing. Probing a different name in the watch root is worse than it sounds: `registerConfig` roots its watcher at the deepest existing ancestor, which for a profile directory that does not exist yet is the Harness home or the user's home, and a `dsh` killed mid-boot would leave the probe behind.

**Poll the file with `fs.watchFile` instead of a timer.** It looks like the smaller change and does not fix this defect. libuv's `uv_fs_poll` stores its first stat as the baseline without reporting it, so a file created between `watchFile()` and that stat is missed by the poll exactly as it is missed by the watch. Comparing the file's text against the generation already applied has no baseline instant, which is why the repair reads content rather than stat metadata — the same reason `hmr-config.spec.ts` grows its fixture file rather than trusting timestamps.

**Reconcile once more after `ready`.** One extra read after registration closes the gap between Chokidar's scan and that read, and leaves the gap between that read and the armed stream — which is the one the test lands in, because it writes after `watchUserPatches` returns.

**Fix `Hmr.registerConfig` instead.** The window belongs to the watch seam, and `registerConfig`'s other caller has the same defect: `hmr-config.spec.ts` :: `observes creation when the config parent did not exist at registration` failed as `HMR did not observe config creation under a new parent` during this work. A seam-level fix still needs an arming proof, which runs into the probe problem above, so the layer that owns the patch-file contract enforces it instead. The vendored seam is unchanged.

## Consequences

One read of one small file every 100 ms per registered patch file — two for a `dsh` profile — for the lifetime of a session, in exchange for a bound on how long the layer may disagree with the file. A caller on a lossier or more expensive filesystem moves `repairInterval`.

The seam's readiness contract is unchanged and still weaker than it reads: `registerConfig` reports ready when Chokidar does. Every other consumer of it keeps the window, `hmr-config.spec.ts` included.

`user-patches.spec.ts` pins the repair path directly rather than by racing it. Three cases register a watcher that never calls back — the shape of a watch armed after its own readiness signal — so what they measure is the cadence: an unreported addition and removal are applied, a broken generation is broadcast once and a recovery still lands, and a non-`Error` rejection is normalized while a throwing observer does not stop the cadence. A fourth drives the shared reconciliation by hand with the cadence set out of reach, pinning that an unchanged, an unreadable, and an already-applied generation each reconcile to nothing.
