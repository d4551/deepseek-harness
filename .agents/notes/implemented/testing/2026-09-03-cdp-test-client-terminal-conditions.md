# Agent Note: A test CDP client's per-call deadline reported host load as a protocol fault

Status: implemented

English | [中文](2026-09-03-cdp-test-client-terminal-conditions.zh.md)

## Problem

The CDP client helper armed a `setTimeout` for every CDP request and rejected with `CDP call timed out: <method>` when it expired: five seconds in `tests/cordis-tree.host.spec.ts`, thirty in `tests/integration.host.spec.ts`, whose comment still described the five seconds it replaced.

That deadline is a second budget racing the one the lane already owns. Both unit projects in `vitest.config.ts` set `testTimeout: 30_000`, so the five-second timer always fired first and Vitest's own budget could never report the case, while the thirty-second one equals the lane budget and races it with no defined winner. Neither number comes from a protocol, a product configuration, or a measured round trip; the test files invented both.

The requests it cut short are the slowest ones the file makes. `Runtime.releaseObjectGroup` for a `tree-host-*` group reaches the Host inspector `Session`, which lives on the test process's main thread; for a `tree-client-*` group it adds a Worker-to-Client round trip through `InspectorQueryConnection`. Neither path carries a product deadline, so on a contended host they take as long as the host makes them take. The case `projects Host and Client trees and resolves both node kinds to RemoteObjects` then failed about one run in ten at peak load, and its failure text named a CDP method — a machine condition presented as an Inspector defect.

A deadline tied to the lane budget instead hides the request. Under load `tests/integration.host.spec.ts` reported `Test timed out in 30000ms` and nothing else, so the file's failures were read as waits on `waitForWorker`; naming the outstanding request showed they were CDP calls that the Host V8 inspector never answered, which is [the Worker's missed answer wakeup](../bug-fix/2026-09-03-inspector-host-answer-wakeup.md).

## Decision

A request settles only on events of its connection: the response carrying its id, a socket close, or a socket error. Elapsed time is not one of them.

`CdpClient` keeps each outstanding request as a `PendingCall` holding its method name and both settlement functions. `abandon` rejects every outstanding request with the terminal condition and the method it was waiting for, and both `close` and `error` on the socket call it. The `error` listener also removes a latent hazard: after `connect` resolved, the socket had no `error` listener at all, and an `EventEmitter` error event without one throws.

`inFlight` names the requests a socket outlives. Each file's `afterEach` reads it before teardown and, after every resource is disposed, throws `Inspector CDP requests never answered: <methods>`. A case that spends the lane's `testTimeout` inside a call therefore reports twice: Vitest states truthfully that the test ran out of time, and the teardown names the method Vitest's message cannot.

`tests/cordis-tree.host.spec.ts` and `tests/integration.host.spec.ts` both carry this helper.

## Alternatives considered

**Raise the five seconds.** `tests/integration.host.spec.ts` had already done this, to thirty seconds, and that value equalled the lane budget it was meant to precede, so the two raced and the loser's message was lost. Relocating a number does not remove it, and any number large enough to survive a loaded host is one Vitest would have reported first anyway.

**Derive the deadline from Vitest's `TestContext.signal`.** The signal aborts exactly when the lane budget expires, so it is an honest source rather than an invented one. It does not survive to the report: Vitest races the test function against its timeout, has already recorded `Test timed out`, and discards the losing rejection. Reporting the pending set from `afterEach` delivers the same method name without threading a signal through every case.

**Keep a timer that adapts to observed load.** A deadline computed from the machine measures the machine, which is the defect restated.

**Extract one CDP client for all four copies of this helper.** `tests/debugger.e2e.ts` and `tests/client-browser.e2e.ts` carry an extra `waitForEvent` and run in the e2e lane, which this change cannot execute; sharing a helper across lanes is a separate change with its own evidence. The two unit-lane copies now hold the same design, so that extraction is a move rather than a rewrite.

## Consequences

A call that is slow but answered now costs wall time instead of failing, and `testTimeout` in `vitest.config.ts` is the single deadline over the case.

A call the socket outlives fails in milliseconds rather than after five seconds, and names its method at the awaiting line.

A genuine hang beyond the lane budget produces two errors instead of one fabricated one, and neither claims a CDP fault that did not occur.

`tests/` carries no coverage obligation, so the per-file gate over `packages/*/*/src` is unaffected.

## Testing

The failure reproduces on demand with a local diagnostic, not a committed fixture: a preloaded module wraps `WebSocket.prototype.send` and blocks the test process's main thread for seven seconds the first time a `Runtime.releaseObjectGroup` request is written. The Host inspector `Session` runs on that thread, so the response genuinely cannot be produced during the block — a starved host, on demand.

Under that harness and a load capped at twice the core count, the file fails twelve runs out of twelve with the previous helper, every failure reading `CDP call timed out`, and passes twelve out of twelve with this one. Twelve unaided runs of the file under the same load also pass, and the whole `packages/experimental/inspector` suite passes at twenty files and one hundred thirty-eight tests.

Raising the block past the lane budget verifies the diagnostic path: Vitest reports `Test timed out in 30000ms` and the teardown reports `Inspector CDP requests never answered: Runtime.releaseObjectGroup`. Terminating the socket mid-request verifies the other: the call rejects in under two hundred milliseconds with `Inspector CDP socket closed with Runtime.releaseObjectGroup in flight`.

`tests/integration.host.spec.ts` is verified the same way against its own copy. Closing the socket fifty milliseconds into a Host `Runtime.evaluate` that awaits a promise nobody settles rejects the call at fifty-two milliseconds with `Inspector CDP socket closed with Runtime.evaluate in flight`; the previous helper held the same call until its thirty-second deadline and then reported `CDP call timed out: Runtime.evaluate`, a CDP fault that did not occur, at the moment the lane budget also expired. Under load its stalled calls now name themselves — `Inspector CDP requests never answered: Runtime.getProperties`, `Runtime.globalLexicalScopeNames`, `Runtime.evaluate`, `Runtime.releaseObjectGroup` — where the previous helper reported only `Test timed out in 30000ms`.

## Deferred

`tests/integration.host.spec.ts` :: `cancels Client Runtime work when the Worker deadline expires` starts the Inspector with `clientRuntimeTimeoutMs: 20` and then needs two round trips it does not test to beat that same twenty milliseconds: the `client-console/enable` handshake its execution-context announcement waits on, and the evaluation that proves the Runtime session survived the cancellation. Above roughly three times the core count the case fails on one or the other — `no execution context named Client — Timeout Client` and `expected undefined to match object { type: 'number', value: 42 }`, four runs in fourteen at load ninety. This is the same defect class as the helper's timer expressed through product configuration, and the value cannot be chosen without either spending that long on the cancellation or accepting the race, so the choice belongs with the case's owner.
