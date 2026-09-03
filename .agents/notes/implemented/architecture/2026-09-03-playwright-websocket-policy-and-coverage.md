# Agent Note: Playwright fetch routes WebSockets through the destination policy

Status: implemented

English | [中文](2026-09-03-playwright-websocket-policy-and-coverage.zh.md)

## Problem

`dsh-web-fetch-playwright` installed one interceptor, `context.route('**/*')`, and four places claimed on that basis that every request a rendered page issues passes the address policy: the module docs of `src/provider.ts` and `src/policy.ts`, and two README paragraphs. Playwright routes WebSockets through a separate API. Its `browserContext._onWebSocketRoute` calls `connectToServer()` when no handler matches, so a rendered page could open `ws://127.0.0.1:*/` or `ws://169.254.169.254/` and read the answers through `onmessage` with no check at all. A negative control confirms the exposure: with the request route installed and no WebSocket route, a page socket to `ws://127.0.0.1:9/` closes with code `1006` — the network refusing a real connection attempt — rather than never leaving the browser.

Four defects travelled with it. The README described a stricter posture than the code delivers, while the composition comment in `packages/bundle/base/cordis.patch.yml` was already honest that Chromium re-resolves at connect. The package held an allowlist entry in `verify-package-readme-limitations` whose justification was a property of an authoring agent's write filter, not of the package. Four source files missed the per-file 100% coverage gate. The apply-time probe launched and closed a whole headless Chromium on every boot, and the install command it printed on failure was not runnable from the repository root, because a workspace install keeps `playwright` out of the root `node_modules`.

## Decision

**WebSocket destinations pass the same policy as requests.** `RenderContext` gained `routeWebSocket`, and `renderAdmitted` installs it beside `context.route` before the context has a page, because Playwright routes only the connections opened after the handler exists. `DestinationPolicy.admitSocket` validates a `ws:`/`wss:` URL by rewriting the scheme to its HTTP equivalent and running the shared `validateFetchUrl` — bounded length, no embedded credentials — then reuses the fetch's per-hostname decision, so `wss://host` costs nothing after `https://host` decided the host. `guardSocket` connects an admitted socket to its server and closes a refused one with RFC 6455 code `1008`; like the request handler, it settles both the decision and the refusal, because a handler that throws leaves the connection pending forever. The matcher is a predicate rather than a glob, so nothing sits between "every connection" and what the browser routes.

**Service workers are blocked in every context.** Playwright's request interceptor never sees a request a service worker issues, so `newContext` passes `serviceWorkers: 'block'`. That closes the same class of bypass on the HTTP side, at the cost of rendering service-worker-dependent sites as a first visit renders them.

**The install probe checks the executable instead of launching one.** `probeChromium` now confirms that `chromium.executablePath()` exists. Measured on a warm host with a fresh process each time: 103 ms for the filesystem probe, nearly all of it importing `playwright`, against 179 ms for launch-and-close — and, the reason for the change, no browser process, no temporary profile, and no way for a wedged launch to hold `apply()` open. `available()` keeps its meaning: one answer resolved before registration, no I/O per selection.

**The install command is resolved, not guessed.** `chromiumInstallCommand()` resolves `playwright/package.json` through this package's own module resolution and prints `node "<pkg>/cli.js" install chromium`, which runs from any directory. The README gained an "Install the browser" step, because nothing in the repository downloads the browser and a pinned `fetchProvider: playwright` without it fails every fetch with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`.

**Two unreachable states were removed rather than covered.** `browserOrRelaunch` opened with `if (this.disposed) throw`, and `dispose()` ended with `if (opened?.ok)`. Neither branch is reachable: `dispose()` aborts the lifetime signal before anything can reach the launch, and every path into `browserOrRelaunch` passes `RenderPermits.acquire`, which rejects on an aborted signal; a launch that fails clears the memo itself, so `dispose()` never observes a rejected one. The leak the disposed check named is prevented by `dispose()`'s own ordering — it waits for every render in flight, then reads the memo, so a process opened during that wait is the process it closes — and that ordering now has a direct test. `dispose()` is total as a result, so the plugin's disposer dropped its `.then(undefined, warnCloseFailure)` and matches the `yield () => x.dispose()` form every sibling package uses.

**The README states the posture the code delivers.** Admission is not pinning, the residual transports are named, and the canonical `## Known Limitations and Deferred Work` section replaced the allowlist entry.

## Verification

`tests/chromium.spec.ts` exercises the launcher, the probe, the executable locator, and the install command against the real `playwright` package and a live Chromium, and proves the fix through the real routing API: a page's `new WebSocket('ws://127.0.0.1:9/')` closes with `1008` from this policy, where the same page without the route closes with `1006` from the network. It self-skips only the browser-dependent cases when no browser is installed; the launcher assertion still runs there and asserts a rejection. The suite is a `*.spec.ts` file, which the coverage lane collects — an `.e2e.ts` file is outside `testIncludes` and would leave the gate unmet.

The port fakes carry the new members, so the unit suites prove the ordering (`route`, `routeWebSocket`, `newPage`), the refusal of loopback, link-local, private, credentialed, non-`ws:` and malformed socket URLs, the connection of an admitted one, the reuse of the page's hostname decision, and the settled handler when the close itself fails. Every file in the package meets the per-file 100% gate — statements, branches, functions, lines — with no exclusion entry, no `v8 ignore`, and no threshold change.

## Alternatives considered

**Refuse every WebSocket outright.** Rejected: the provider serializes the DOM at `domcontentloaded`, so a blanket refusal would be simpler and stricter, but it breaks pages whose scripts fail loudly without their socket, and the address rule already has an exact answer for a public destination.

**Match WebSockets with the `'**/*'` glob used for requests.** Rejected: the glob's behavior against `ws:` URLs is Playwright's business, and a security control should not depend on matcher semantics inferred from HTTP. A predicate that returns true states the intent directly.

**Keep the launch-and-close probe and make availability lazy instead.** Rejected: laziness moves the same browser launch into the first fetch and makes `available()` either dishonest or I/O-performing. The filesystem check answers the same question at boot, and its weaker guarantee — the executable exists, not that it starts — is recorded in the README.

**Cover the unreachable `disposed` and `opened.ok` branches with scheduling tricks.** Rejected: reaching them needs a test that lands `dispose()` in a specific microtask window, which pins V8 scheduling rather than behavior. Deleting unreachable code is what the per-file gate is for.

**Block dedicated workers, or inject a `Content-Security-Policy`, to close the worker-socket gap.** Rejected for now: removing `Worker` from every realm, or rewriting every response to add a header, costs the rendering fidelity this package exists to provide. The gap is documented, pinned by a test, and narrower than it looks (see below).

## Consequences

- A rendered page reaches `ws:`/`wss:` destinations only through the address policy, and a refused connection reports `1008` to the page rather than a network error.
- Service-worker-dependent sites render as a first visit renders them; that is now a stated behavior boundary.
- Boot no longer spawns a browser process to answer "is one installed", and every printed install command is runnable where it is printed.
- **A dedicated worker's WebSocket is still not routed.** Measured against a live Chromium: neither `browserContext.routeWebSocket` nor `page.routeWebSocket` sees a socket a `new Worker(...)` script opens — the handler list stays empty and the page observes `1006`. HTTP requests from the same worker *are* intercepted, also measured, so the residual path reaches WebSocket servers on private addresses only; a non-WebSocket service never completes the handshake and returns no data to the page. `tests/chromium.spec.ts` pins the gap so an upstream fix turns the assertion red and the limitation leaves the README.
- **Admission remains admission.** Chromium re-resolves the hostname when it connects, so a name that answers publicly at admission and privately at connection reaches the private address. `fetchProvider: http` is the pinning backend; closing it here needs a browser-level resolving proxy or an upstream hook.
- WebRTC data channels and WebTransport are routed by nothing in Playwright; disabling them at launch is deferred work.
