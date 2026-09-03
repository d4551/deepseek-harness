# Agent Note: A Client realm was announced before it could forward Console calls

Status: implemented

English | [中文](2026-09-03-inspector-realm-console-forwarding.zh.md)

## Problem

A Client realm installs its Console observer only when the Worker's `client-console/enable` frame reaches it. `ClientRuntimeRouter.subscribeConsole` wrote that frame to the source socket and returned a disposer in the same turn, so the Worker treated a dispatched enable as an established subscription. `RuntimeDomainSession` then answered `Runtime.enable` and sent `Runtime.executionContextCreated` while the frame was still in flight.

Anything that learned about the realm from those two signals and then made the realm log raced the frame. `ClientConsoleObserver.captureConsole` fans out to the sessions enabled at capture time and keeps no history, so a call that lands in the gap is dropped once and never retried — the observer's `console.log` replacement is not even installed yet on the first enable. The loss is silent in both directions: the Client sends nothing and the Worker waits for an event that will never exist.

`tests/integration.host.spec.ts` :: `forwards Client Console objects through isolated realm sessions` hit this about half the time, exhausting its 15s budget rather than failing fast. A stderr trace of a failing run put the fixture's `console.log` one millisecond ahead of both connections' enable frames:

```
DIAGF 1788421304621 log-value
DIAGC 1788421304622 enable a63093bf-… closed=false active=false
DIAGC 1788421304623 enable 5ee1a073-… closed=false active=true
```

Both connections lost the event, which is what the missing-symmetry evidence predicted: the two enables travel one socket in order, so the window either catches both or neither.

## Decision

`ConsoleBackend.subscribe` returns `Promise<() => void>` and resolves only once the realm forwards events to the listener. `HostConsoleBackend` resolves immediately — the native session already delivers into its notification channel. `ClientConsoleBackend` resolves on a new `client-console/enabled` frame the Client sends after `ClientConsoleObserver.enable` installs the observer, correlated by source generation and Runtime session and bounded by the router's existing `clientRuntimeTimeoutMs`. One `ConsoleSubscription` record owns the whole session: listener, confirmation resolvers, and deadline settle and are discarded together on confirmation, disposal, session close, source close, or router close.

`RuntimeDomainSession` keeps the subscription promise rather than a disposer, so `attachConsole` is idempotent and every caller — the `Runtime.enable` loop and the realm-opened path — awaits the same establishment before `announce` runs. A realm whose Console or Runtime cannot be prepared is closed instead of announced, which is what the realm-opened path already did for a failing Runtime enable.

Ordering the announcement behind a round trip would have put a reconnected Client's Elements updates ahead of its execution context, which `tests/cordis-tree.host.spec.ts` :: `restores a disconnected Client tree from a new transport generation` pins. Two ordering facts keep that intact:

- `InspectorSourceRegistry.open` emits `opened` before replying `source/accepted`. A source publishes the moment it reads that reply (`ClientBridgePublisher.accept` sends the replacement synchronously), so a capability frame a consumer sends for the generation has to be on the wire ahead of it.
- `openRealm` starts the Console subscription before awaiting the Runtime enable. `attachConsole` reaches `sources.send` with no intervening `await`, so the enable frame is written inside the `opened` emit rather than a microtask later. Subscribing before enabling is also the safer order for the Host: no native notification can arrive between the two.

The Client therefore installs its observer and acknowledges before it processes `source/accepted`, and the acknowledgement reaches the Worker ahead of the first record frame.

## Alternatives considered

**Gate only the `Runtime.enable` reply.** It satisfies the CDP contract for a connection that enables after the Client is present, and it leaves the observed failure untouched: in this case the realm opened after `Runtime.enable`, so the announcement was the only signal and it still preceded the subscription.

**Use an existing Runtime round trip as the barrier.** `release-object-group` or `global-lexical-scope-names` would prove the enable frame was processed, because the Client handles socket frames in order. The proof lives in a comment rather than in the protocol, and a reader has to reconstruct it from an unrelated operation.

**Buffer Console calls in the Client and replay them on enable.** This is what V8 does for `Runtime.enable`, and it would also cover calls made before any DevTools connection exists — the real product exposure a page that logs during load has. It needs bounded message storage, `discardConsoleEntries` semantics over it, and retention of live page objects until some session serializes them. That is a feature, not this defect.

**Let the test wait for a longer or retried signal.** Nothing observable proved Console readiness, so any wait would have been a sleep against an event that had already been dropped for good.

**Change the reconnect ordering assertion instead.** The Elements tree for a Client is never updated before DevTools knows that Client's execution context; a RemoteObject naming an unannounced context is exactly what that assertion exists to prevent.

## Consequences

`Runtime.enable` and each synthetic `Runtime.executionContextCreated` now mean that this connection's Console forwarding for the announced realms is live. `Runtime.enable` costs one Worker-to-Client round trip per connected Client realm; the affected case went from ~165ms to ~215ms. A Client that never confirms fails the enable with `Client Console enable timed out after <n>ms` after `clientRuntimeTimeoutMs`, which is the same all-or-nothing rollback the enable already applied to a Client that disconnected mid-attach.

The wire gains one source-to-Worker frame, `client-console/enabled`, carrying the source, generation, and session it confirms. Both peers ship together under a single `INSPECTOR_PROTOCOL_VERSION`, so no peer sends the old frame set.

Console calls a Client makes before a DevTools connection has subscribed are still lost. The realm-announcement guarantee does not extend to them, and closing that gap needs the message store rejected above.

## Testing

`tests/protocol.host.spec.ts` decodes `client-console/enabled` and rejects an extra field, a missing `sessionId`, and the Worker-to-Client `client-console/enable` tag on the source carrier. The behavior itself is pinned by the previously flaky integration case, which now passes deterministically: twelve consecutive runs of `tests/integration.host.spec.ts` green at ~215ms, against four failures in six runs with the source reverted.
