# Agent Note: A parked Inspector Worker missed the Host inspector's answer

Status: implemented

English | [中文](2026-09-03-inspector-host-answer-wakeup.zh.md)

## Problem

Every Host-realm CDP request the Inspector Worker serves ends at `HostInspectorSession.request`, which posts the method on a `node:inspector` `Session` bound with `connectToMainThread()`. The Host V8 inspector lives on the process's main thread, so the answer crosses back into the Worker through the runtime's own cross-thread delivery.

Under host load that answer arrives, but not when it is produced. `Runtime.evaluate`, `Runtime.getProperties`, `Runtime.globalLexicalScopeNames`, and `Runtime.releaseObjectGroup` were each observed posted and then unanswered for between eight and thirty seconds, after which the callback delivered an ordinary result — including trivial ones such as `Invalid remote object id`, which V8 answers in under a millisecond on an idle host. Nothing in the Worker or the request explains the gap: a hundred-millisecond heartbeat on the main thread never missed a tick during a stall, a second CDP call issued five seconds into one was answered in one millisecond, and the parameters, the method, and the number of DevTools connections make no difference.

What does make the difference is whether the Worker's own event loop turns. The Worker awaiting an answer has no other work, so its loop parks, and the wakeup that should deliver the answer is lost; a loop that turns drains it. An unreferenced hundred-millisecond timer inside the Worker removed every stall: over nine runs each way at the same host load, six runs stalled between 28.7 and 29.6 seconds without it and none stalled with it, the worst latency falling to 85 ms.

`tests/integration.host.spec.ts` was the reporter. Once [the CDP test client's terminal conditions](../testing/2026-09-03-cdp-test-client-terminal-conditions.md) let it name an outstanding request, its load failures read `Inspector CDP requests never answered: <method>` and named the four methods above, in four of its cases.

## Decision

`HostInspectorSession` counts the requests it has posted and holds one unreferenced interval of `HOST_ANSWER_WAKEUP_MS` while that count is above zero. The timer carries no work: turning the Worker loop is the whole effect. It starts with the first outstanding request and stops with the last, so an idle Worker still parks, and `unref` keeps it from holding the Worker open.

The interval bounds the delay a missed wakeup can add. It is not a deadline: no request fails when it elapses, and the lane's `testTimeout` and the caller remain the only limits on how long an answer may take.

## Alternatives considered

**Give Host requests a deadline, as Client requests have.** `ClientRuntimeRouter` bounds each Worker-to-Client command with `clientRuntimeTimeoutMs` because a Client is a separate process that may vanish. The Host V8 inspector is in this process and always answers; a deadline over it would convert a delivery stall into a fabricated protocol failure, which is the defect [the CDP test client note](../testing/2026-09-03-cdp-test-client-terminal-conditions.md) removed from the test side.

**Retry the request after a delay.** V8 has already accepted the message and will answer it; a second copy would execute twice and both answers would be correlated to different ids.

**Keep a referenced handle instead of a timer.** A referenced handle keeps the loop alive but does not make it turn, and the answer is delivered on a turn.

**Chain `setImmediate` while requests are outstanding.** This turns the loop continuously and spends a core doing it, for the same effect a timer achieves at one turn per interval.

**Move the Host inspector `Session` to the main thread and proxy it over the existing control port.** This removes the cross-thread inspector path entirely rather than containing it, and it relocates per-connection V8 session ownership out of the Worker that holds every other realm session. It is the right shape if the runtime behavior proves permanent, and it is a larger change than this defect justifies today.

## Consequences

A Host-realm CDP answer that the runtime does not deliver promptly is now delayed by at most one interval instead of by seconds, for DevTools users as well as for tests.

The Worker holds one timer while it is waiting on the Host and none while it is idle, so a running Inspector adds a wakeup only during work it is already blocked on.

The cause sits below this repository. If it is fixed in Node, or if the affected versions are identified, this containment is a single field and a single interval to delete.

`src/worker/realms/**` is outside the per-file coverage gate because the Worker thread is not attributable to the parent process, so the new paths are covered by behavior tests rather than by that gate.

## Testing

The stall reproduces without Vitest, the Client fixture, or the test file: a script that starts one Inspector, opens one CDP connection, and issues sixty rounds of `Runtime.evaluate`, `Runtime.getProperties`, and `Runtime.releaseObjectGroup` against the Host realm stalls under load. It reproduces the same way against the source at `HEAD`, so it predates the Inspector changes landed the same day.

The containment is A/B'd on itself with a flag that skips `retainWakeup` in a copy of the shipped source. Nine runs with it skipped stalled in six, worst latencies 29595, 29552, 29428, 29428, 29343, and 28713 ms; nine runs with it applied, at higher load, stalled in none, worst latency 85 ms.

`tests/integration.host.spec.ts` passes fourteen consecutive runs at ten tests each under a load capped at twice the core count, and the whole `packages/experimental/inspector` suite passes at twenty-one files and one hundred forty-one tests. Above roughly three times the core count the file still fails, but only in `cancels Client Runtime work when the Worker deadline expires` and on that case's own `clientRuntimeTimeoutMs: 20`, recorded in the CDP test client note.
