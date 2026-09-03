# Agent Note: A Worker-to-Client deadline ended work it did not bound

Status: implemented

English | [中文](2026-09-03-inspector-client-deadline-scope.zh.md)

## Problem

`clientRuntimeTimeoutMs` bounds one Worker-to-Client round trip. In two places its expiry ended work that round trip does not own.

`RuntimeDomainSession.enable()` awaited `Promise.all` over every realm, so one Client whose `client-console/enable` was never confirmed rejected `Runtime.enable` for the whole DevTools connection: the catch cleared `enabled`, detached every Console subscription, cleared the announced contexts, and called `Runtime.disable` on every realm, the Host included. `announceRealm`, which admits a realm that arrives after the enable, contains that identical failure inside the realm that produced it — it drops that one realm and announces nothing else. The same Client failing the same way therefore either blinded the connection or did not, according to whether it connected before or after `Runtime.enable`. A DevTools user inspecting a Host and two Clients lost the Host and the healthy Client to the third one's silence.

`tests/integration.host.spec.ts` :: `cancels Client Runtime work when the Worker deadline expires` starts the Inspector with `clientRuntimeTimeoutMs: 20` and then needed two round trips it does not test to complete inside those same twenty milliseconds: the Console enable handshake its execution-context announcement waits on, and the evaluation that proved the Runtime session survived the cancellation. Above roughly three times the core count it failed on one or the other — `no execution context named Client — Timeout Client`, or `expected undefined to match object { type: 'number', value: 42 }` — four runs in fourteen at load ninety. Setup that must beat the deadline under test makes the case an assertion about the host's speed, which is [the defect the CDP test client's own timer carried](../testing/2026-09-03-cdp-test-client-terminal-conditions.md) restated through product configuration.

## Decision

One `admitRealm` serves both admission paths. It subscribes Console and enables Runtime for one realm, returns that realm when both succeed, and otherwise detaches the subscription, closes the realm session, and returns nothing. `enable()` maps it over the registry's realms and announces the ones it returned, in registry order rather than completion order; `announceRealm` awaits it for one realm and announces that realm if it survived. `Runtime.enable` no longer fails for a realm, and no realm's failure reaches a sibling.

Containment is uniform across realm kinds, as the rest of `RuntimeDomainSession` is. A Host realm that could not be admitted is dropped the same way, and the connection's next Host request fails at the closed native session rather than being reported as an enable that already returned.

The case configuring the deadline drives a Client peer that answers nothing and declares only the `client-runtime` capability. Console is optional for a Client source, so `attachConsole` reports that realm's own `console: unsupported` and the Client Runtime enable is Worker-local: the connection admits and announces that realm with no Worker-to-Client round trip. Both evaluations the case then issues are ones the peer can never answer, so each ends only in the deadline, and a slower host makes that more certain rather than less. The second evaluation is the survival assertion: a realm the cancellation had torn down answers `Client execution context is no longer available` instead, and `DSHInspector.getSources` still lists the source the Worker kept.

The two facts that case dropped are asserted where they are deterministic. `tests/protocol.host.spec.ts` drives `ClientRuntimeRouter` against a source-registry double: the expired request emits one `client-runtime/cancel` carrying its own request id, and the next request on that session is answered and acknowledged. `tests/plugin.client.spec.ts` :: `cancels an outstanding Client Runtime operation without sending a late response` already holds the Client half, where a request issued after a cancellation is still served.

## Alternatives considered

**Raise `clientRuntimeTimeoutMs` in the case.** The number moves; the race does not. Any value large enough to survive a loaded host is one the cancellation then spends on every run, and the case still asserts that two untested round trips beat it.

**Keep the real Client fixture and address its realm by unique context id.** `Runtime.evaluate` accepts `uniqueContextId` without `Runtime.enable`, so the handshake could be skipped — but the test would have to build `dsh-client:<sourceId>:<generation>` itself, making a third home for a format the Worker owns, and the evaluation proving survival would still race the deadline.

**Move the case out of the real Worker into the in-process assembly** that `tests/announcement-barrier.host.spec.ts` uses. Everything becomes deterministic, including a successful follow-up, but nothing then proves that `clientRuntimeTimeoutMs` given to `startInspector` reaches the router in the Worker. The router-level case carries the parts that need doubles; the real-Worker case keeps the configuration path.

**Give the Console enable its own configured deadline** so the case could leave it at the default. It is one Worker-to-Client round trip like the others and has no consumer asking to bound it separately; a second field would exist only to let one test choose two numbers.

**Expose a Worker signal the case could await for a cancellation.** Nothing outside the deadline observes it today, and a new public surface with one test caller is a test hook wearing a configuration name.

**Keep `enable()` failing when the Host realm cannot be admitted.** That reintroduces the asymmetry inside the new helper, for a path with no reachable failure: the Host Console subscription resolves on return and the Host V8 session answers `Runtime.enable` in-process. A Host special case would have to be maintained without a case that reaches it.

## Consequences

`Runtime.enable` returns `{}` and announces the realms this connection admitted. A DevTools frontend attached to a Host and several Clients keeps every realm that works, and one unresponsive Client costs it that Client's context and nothing else. The all-or-nothing rollback recorded in [the realm Console forwarding note](2026-09-03-inspector-realm-console-forwarding.md) is gone; the Client realm is closed for the connection that could not admit it and stays connected to the Worker for the others.

A Client realm dropped at `Runtime.enable` is not retried on that connection. The Worker keeps the source, so a DevTools reload opens a new connection that admits it again.

The deadline case no longer exercises the real Client executor's cancellation path; `tests/plugin.client.spec.ts` and `tests/client-runtime.client.spec.ts` own that half, and the Worker half now has assertions it never had.

## Testing

The two failures reproduce without load, through a local diagnostic rather than a committed fixture: the Client fixture wraps `WebSocket.prototype.send` and delays the frames the Worker waits on. Delaying `client-console/enabled` by sixty milliseconds fails the previous case with `no execution context named Client — Timeout Client`; delaying `client-runtime/response` fails it with `expected undefined to match object { type: 'number', value: 42 }`. Both are the load failures named above, on demand. The current case passes under each delay and under both together.

`tests/integration.host.spec.ts` passes twelve consecutive runs, and the whole `packages/experimental/inspector` suite passes twelve consecutive runs at twenty-one files and one hundred forty-three tests, under a load of thirty-six shell workers on eighteen cores that peaked at a load average of sixty-four — above the three-times-cores threshold at which the previous case failed.

The realm containment is proved by reverting it: with the previous `enable()`, `keeps the Host realm on a connection whose Client realm never confirms its Console` fails with `Client Console enable timed out after 20ms` as the response to `Runtime.enable`. With the containment, that enable succeeds, a `node:vm` context created afterwards is still announced to the connection — which the previous rollback's `Runtime.disable` on the Host realm prevented — and evaluation in it still answers.

`tests/announcement-barrier.host.spec.ts` pins the ordering the announcement counter owns and passes unchanged: `admitRealm` keeps one increment and one settlement per admission on both paths.
