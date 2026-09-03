# Agent Note: Elements updates raced the execution context that owns them

Status: implemented

English | [中文](2026-09-03-inspector-dom-delivery-behind-announcement.zh.md)

## Problem

`RuntimeDomainSession` announces a Client realm's synthetic execution context after `openRealm` resolves, and that resolution waits for the Client's `client-console/enabled` reply. A reconnecting Client writes that reply and its first `source/replace` frame in one turn, because the Worker writes `client-console/enable` and `source/accepted` in one turn. One Worker socket read can therefore carry both, and `ws` emits both messages inside that read: the record frame installs the new generation's tree and writes `DOM.childNodeRemoved` and `DOM.childNodeInserted` synchronously, while the announcement is still a queued microtask continuation behind the establishment promise.

DevTools then learns of Elements nodes for a generation whose context it has not been told about, which is what a `RemoteObject` naming an unannounced context makes unsafe. `tests/cordis-tree.host.spec.ts` :: `restores a disconnected Client tree from a new transport generation` pins the order and failed under machine load with `expected 1 to be greater than 3`; the delivered order was `Runtime.executionContextDestroyed`, `DOM.childNodeRemoved`, `DOM.childNodeInserted`, `Runtime.executionContextCreated`. Run alone, the two frames land in separate reads, the microtask drains between them, and the case passes — so the defect presented as a suite-load flake rather than a failure.

The two ordering facts recorded in [realm Console forwarding](2026-09-03-inspector-realm-console-forwarding.md) order the frames on the wire, and they still hold. Neither orders the Worker's own delivery once a single read carries the reply and the record frame, because record ingestion is synchronous with the read and the announcement is not.

## Decision

`RuntimeDomainSession` counts the announcements it owes. Admission of a realm while the domain is enabled and each `Runtime.enable` call raise the count; the count falls when the context is announced or the realm is dropped. `announcementPending()` reports the state and `onAnnouncementSettled()` reports each settlement.

`CordisDomSession` reads that state before applying any backend change. While an announcement is pending it appends the change to a connection-local queue and returns; on each settlement it drains the queue back through the same entry point, so a change still inside a pending window is re-queued in order and a change outside one is applied. Order is preserved for the whole stream rather than per source, because the frontend replays a mutation sequence against the tree it already holds. `DOM.getDocument` discards the queue: the response carries the current document, so the increments that produced it are spent.

The barrier is connection-local. A DevTools connection that is slow to admit a realm withholds only its own Elements updates, and the Worker keeps ingesting records for every other consumer.

## Alternatives considered

**Announce before awaiting the Console subscription.** This restores the order structurally and returns each synthetic `Runtime.executionContextCreated` to meaning "the enable frame was dispatched" — the exact loss [realm Console forwarding](2026-09-03-inspector-realm-console-forwarding.md) closed, where a Console call made in the gap is dropped once and never retried.

**Delay `source/accepted`, or hold record ingestion, until every connection has announced the generation.** Either one makes the order a property of the protocol, and both couple one DevTools connection's admission to the data every other consumer receives. `InspectorSourceRegistry` isolates consumers from admission deliberately, and a stalled connection would stop the source's publishing for the Worker.

**Emit the announcement synchronously from the frame that establishes the subscription.** This is the narrowest repair of the announcement itself, but it threads an establishment callback through `ConsoleBackend.subscribe`, both backends, and the Client Runtime router, and it leaves the race open for a Client that declares no Console capability, whose announcement rides a resolved promise instead.

**Deliver DOM changes one macrotask later.** The pending announcement chain would win today, and the ordering would again rest on how many microtask hops the announcement path happens to take. Any `await` added to that path reopens the defect silently.

**Weaken the assertion, retry the case, or wait longer.** The assertion states the guarantee; the order it observed was wrong, not late, and no additional waiting changes an order already written to the transport.

## Consequences

A connection that owes an announcement withholds Elements updates for one Worker-to-Client round trip, or for `clientRuntimeTimeoutMs` when a Client never confirms its Console enable, and then delivers the held changes in order. Nothing is dropped or coalesced, and `DOM.documentUpdated` is still never used for this path.

`Runtime.enable` now holds the same barrier for its own duration, so a first connection cannot receive nodes for realms it is still admitting.

`src/worker/cdp/**` is exempt from the per-file coverage gate because the Worker thread is not attributable to the parent process, so the new paths are covered by behavior tests rather than by that gate.

## Testing

`tests/cordis-tree.host.spec.ts` :: `restores a disconnected Client tree from a new transport generation` remains the pin. With the Worker's ingest reads coalesced into one 50 ms batch — the read pattern a loaded event loop produces — the case fails on every run without this change and passes on every run with it; twelve consecutive unaided runs of the file also pass under host load. `tests/announcement-barrier.host.spec.ts` is the committed guard: it assembles the Worker's source registry, routers, realms, and both CDP domain sessions without either socket, then delivers the Client's Console confirmation and the new generation's first records in one turn, which makes the coalesced read the case under test. It fails on every run with the barrier removed from `updateDocument`, and its `DOM.getDocument` case fails with the queue discard removed. The coalesced-read harness over a real socket stays a local diagnostic: the suite still cannot force one socket read to carry both frames.
