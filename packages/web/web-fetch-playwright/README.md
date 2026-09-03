---
description: "The Playwright Chromium rendered-page fetch backend for ctx.web: how deployments mount DOM-rendering URL retrieval with anonymous incognito contexts, one shared browser process, and bounded output."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-playwright

English | [中文](README.zh.md)

## Summary

With `dsh-web-fetch-playwright`, the harness can fetch JavaScript-rendered pages through the web service (`ctx.web`): it loads each URL in a headless Chromium browser, waits for the DOM, and returns the serialized document. Choose it when a composition needs what plain HTTP retrieval cannot produce — the client-rendered DOM of single-page applications, pages that build their content with scripts, or any document whose meaningful markup exists only after execution. It stays anonymous like the HTTP backend: no credentials, no cookies carried between fetches, each render isolated in a fresh incognito context. Every destination a page reaches — main frame, subresources, each hop a redirect names, and every WebSocket its page and frames open — passes the shared fetch URL policy and is admitted only for a public unicast destination; unlike the HTTP backend, the browser resolves each hostname again when it connects, so that check admits a destination instead of pinning one. The model-facing `web_fetch` tool lives in `dsh-tool-web`, which renders this provider's bodies.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Behavior Boundaries](#behavior-boundaries)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `playwright` fetch provider. It is the shipped fetch route: the `dsh` base bundle pins `fetchProvider: playwright`, so every profile built on that core renders. A composition that wants the plain HTTP backend instead — because it cannot install a browser, or because it needs address pinning — states `fetchProvider: http` on the `web` row.

### When to choose it

Choose this backend when a deployment must retrieve pages whose content is built by client-side scripts and the plain HTTP backend would return an empty shell: single-page applications, script-assembled documents, or pages that require a real DOM to produce their markup. It requires a Chromium installation (`playwright`'s browser binaries) on the host.

### Install the browser

Nothing in this repository downloads that Chromium for you: `playwright` ships no postinstall step, and a fresh clone therefore has the package but not the browser. A composition that pins `fetchProvider: playwright` on such a host mounts a provider the seam reports as unavailable, and every `web_fetch` fails with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`. Because the shipped profiles pin this route, that install is a required deployment step, stated in the base bundle's README as well as here. Install the browser once from the repository root:

```sh
node packages/web/web-fetch-playwright/node_modules/playwright/cli.js install chromium
```

The path is explicit because `playwright` is a workspace dependency of this package rather than of the repository root: a bare `playwright install chromium` finds no command there, and `npx playwright install chromium` downloads an unrelated copy of the package to run. Outside this repository, where `playwright` is the consumer's own dependency, `npx playwright install chromium` is the same operation. The plugin's apply-time warning and its launch failures both print the command for the installation they resolved, so the message names a runnable command wherever it is read. When `playwright` itself is absent — it is a peer dependency, so a deployment can mount this plugin without it — that command installs the package and its browser together, because the browser alone would leave the provider unable to launch it.

### Minimal configuration

Load the web service, select this provider for fetch, and mount the provider; configurable limits have safe defaults and validate at plugin construction, so an invalid value fails loudly instead of building a provider with nonsensical caps.

```yaml
- name: '@deepseek-ai/dsh-web'
  with:
    fetchProvider: playwright
- name: '@deepseek-ai/dsh-web-fetch-playwright'
```

| Field | Default | Meaning |
|---|---|---|
| `maxBodyChars` | `100,000` | Maximum serialized DOM length in characters |
| `timeoutMs` | `30,000` | Per-fetch budget — a resource backstop, not the model-facing tool budget |
| `maxConcurrentRenders` | `2` | Renders holding a browser context at the same time; the rest queue in arrival order |
| `userAgent` | `deepseek-harness/0.0.1 (+https://github.com/deepseek-ai)` | `User-Agent` every rendered request carries |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-fetch-playwright) is the exhaustive source for every accepted field and its JSDoc.

### What a fetch returns

A successful call yields a `WebFetchResult`: the page's final URL after navigation (redirects included), the HTTP status of the main navigation (a synthetic navigation reports `200`), the serialized DOM as an `html` body, and a `truncated` flag when the document exceeds `maxBodyChars`. A non-2xx status is a result, not an error — `WebError` is reserved for failures to launch, navigate, or serialize.

### Render behavior

The provider accepts only `http:` and `https:` URLs without embedded credentials, under the shared fetch URL policy. It then guards the context on all three channels a destination can arrive on — the request interceptor, the WebSocket interceptor, and the context's own request observer, where a redirect hop appears — and admits a destination only when it is a public unicast address. A refused request is aborted as `blockedbyclient`; a refused WebSocket is closed with code `1008` before it reaches any server; a refused navigation target reports `WEB_BLOCKED_URL` before any browser work runs; and a refused redirect hop fails the whole fetch with `WEB_BLOCKED_URL`, decided after navigation and before the document is read. `ws:` and `wss:` carry the rules of `http:` and `https:`, and one decision is memoized per hostname for the life of a fetch, so a page load decides each host once and `wss://host` reuses what `https://host` decided.

All three are installed before the context has a page, because Playwright routes only the WebSockets opened after the handler exists, and every context blocks service workers, because requests a service worker issues never reach the request interceptor. A redirect hop fails the fetch rather than one request: by the time Chromium reports it, the page already holds that hop's response, so aborting the single request would leave its bytes in the document this provider is about to serialize. The request interceptor covers requests a dedicated worker issues; the WebSocket interceptor does not cover a connection a dedicated worker opens, which is recorded below.

That check admits a destination; it does not pin one. `dsh-web-fetch-http` resolves a hostname once and pins the connection to the addresses it validated. Chromium resolves the hostname itself when it connects, so a name that answers with a public address while the policy decides it and a private address when the browser connects reaches the private address — see [Known Limitations and Deferred Work](#known-limitations-and-deferred-work).

Each fetch opens a fresh incognito context in one shared browser process, navigates with `domcontentloaded`, serializes the DOM, and closes the page and context; no cookies, storage, or authentication survive a fetch. At most `maxConcurrentRenders` fetches hold a context at once; the rest wait in arrival order and give up when their own deadline aborts.

The plugin probes the Chromium installation once while applying — one filesystem check for the executable a launch would run, not a browser process — and logs a warning naming the install command when that executable is missing, so the service reads availability without probing per selection and without launching a browser on every boot. The browser process itself launches lazily on first fetch and is reused; a launch that fails or a process that dies clears the memo so the next fetch retries. Disposal is terminal: it cancels the renders in flight, closes the process — including one a racing render opened while disposal waited — and makes every later fetch fail with `WEB_PROVIDER_ERROR`.

### Failures and recovery

Failures throw `WebError` with a machine-routable code: `WEB_INVALID_URL`, `WEB_BLOCKED_URL`, `WEB_FETCH_TIMEOUT`, `WEB_ABORTED`, or `WEB_PROVIDER_ERROR`. Callers that use `ctx.web.fetch` route on the code; the model-facing `web_fetch` tool surfaces the failure text to the model in its own error envelope.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is built on one separation and one layered timeout:

- **Rendered retrieval vs. presentation.** This provider owns URL validation, the browser lifecycle, navigation, DOM serialization, and the character cap; `dsh-tool-web` owns HTML→markdown and truncation formatting. A non-2xx navigation is data, not failure.
- **Address policy at the browser edge.** Interception, not URL validation alone, is where the public-destination rule holds: a rendered page reaches destinations the caller never named, so the same policy decides the main frame, every subresource, every hop a redirect names, and every WebSocket. Each destination kind arrives on its own Playwright channel — the request interceptor, the WebSocket interceptor, and the context's request observer, which is the only channel a hop the browser follows on its own appears on. A policy wired to one channel covers only that channel.
- **Two timeout layers.** The provider's `timeoutMs` is a resource backstop that also bounds Playwright's own navigation timeout; the model-facing tool-call budget belongs to `dsh-tool-call-timeout-policy`, which arms `exec.signal`. When the outer deadline fires first the provider reports `WEB_ABORTED` and the policy replaces it with `TOOL_TIMEOUT`; `WEB_FETCH_TIMEOUT` therefore identifies a service caller whose provider budget elapsed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, limit validation, provider registration, browser close on dispose |
| [`src/provider.ts`](src/provider.ts) | The `PlaywrightFetchProvider`: shared-browser lifecycle, incognito renders, DOM serialization |
| [`src/policy.ts`](src/policy.ts) | Destination policy: per-request, per-redirect-hop and per-WebSocket admission, one decision per hostname, and both interceptor handlers |
| [`src/browser.ts`](src/browser.ts) | Browser ports the provider depends on, Chromium launch and install probe, the resolved install command, and the in-page DOM serializer |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; limits are enforced in the provider) |

### Read path

A fetch validates and admits the navigation target, takes a render slot, then reuses or launches the shared browser and opens a fresh incognito context. It installs the request observer, the request interceptor and the WebSocket interceptor on that context before opening a page, navigates under the provider timeout with `domcontentloaded`, settles every redirect hop the navigation reported, serializes the DOM, and closes the page and context before returning — so cleanup runs even when serialization fails, and no document is read behind a refused hop. A dead or failed launch clears the memoized browser so the next fetch retries instead of pinning a broken process. Disposal waits for the renders in flight and then reads that memo, so a process one of them opened while disposal waited is the process disposal closes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shared vocabulary to the service, the model-facing tools, and the design rationale.

- [Web subsystem](../../../docs/subsystems/web.md) — the exhaustive fetch request/result vocabulary and error codes.
- [Web package map](../README.md) — the seven-package family and each role.
- [dsh-web](../web/README.md) — the web service this provider registers into.
- [dsh-web-fetch-http](../web-fetch-http/README.md) — the anonymous HTTP backend for server-rendered pages; the two fetch backends cover complementary page classes.
- [dsh-tool-web](../tool-web/README.md) — the model-facing `web_fetch` tool that renders this provider's bodies.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-web-fetch-playwright) — every accepted config field and its source declaration.
- [Web capability seam decision](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) — why search and fetch share one provider-selection service.

-----

<a id="behavior-boundaries"></a>
## Behavior Boundaries

These boundaries define what the provider does not attempt; they are current package contracts.

- **No post-DOM waiting** — navigation settles at `domcontentloaded`; content that appears only after later network activity, lazy loading, or hydration will be absent from the serialized DOM. An explicit network-idle wait is the next capability to add here.
- **Every fetch is anonymous** — no cookie or session persistence; pages that require login return their logged-out markup, and no fetch backend in this family performs authenticated retrieval.
- **No service workers** — every context blocks registration, because Playwright's request interceptor never sees a request a service worker issues; a site whose content depends on one renders as it does on a first visit.
- **Host browser dependency** — Chromium must be installed through `playwright`'s browser binaries; the plugin reports a missing installation as an apply-time warning naming the install command, the seam then refuses the provider with `WEB_PROVIDER_CONFIGURED_UNAVAILABLE`, and a fetch that reaches a broken installation fails with `WEB_PROVIDER_ERROR`.
- **Disposal is one-way** — a disposed provider accepts no further fetch, so a composition that unloads and remounts the plugin gets a new provider rather than a revived browser.

-----

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through `dsh-tool-web`, which renders the `maxBodyChars`-bounded DOM as markdown in its fetch result.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These are the destination-policy gaps a deployment inherits and the maintainer constraints behind them. They are current package limits, not defects to route around.

- **Admission is not address pinning** — the policy decides a hostname and Chromium resolves it again when it connects, so a name that answers with a public address at admission and a private one at connection time reaches the private address. Playwright exposes no connection-level address hook to pin against, so closing this needs either a browser-level proxy that resolves and pins for Chromium or an upstream pinning API; a deployment that needs pinning today states `fetchProvider: http`.
- **A refused redirect hop is refused after the request, not before it** — Chromium follows a redirect inside its own network stack and does not re-enter `context.route` for the hop; it reports the hop on the context's `request` observer, which is where this provider decides it. The decision therefore lands after the browser has already issued that request, so a refused hop stops the content reaching the caller — the fetch fails with `WEB_BLOCKED_URL` before the document is read — but does not stop the request itself, leaving a blind request to the refused address. Preventing the request needs following redirects by hand through `route.fetch` and fulfilling the final response, which moves every request a page issues off Chromium's own network stack and changes what `page.url()` reports; `fetchProvider: http` prevents it today by resolving and pinning each hop before it connects.
- **A dedicated worker's WebSocket is not routed** — Playwright routes the WebSockets a page or frame opens, and neither `browserContext.routeWebSocket` nor `page.routeWebSocket` sees one a `new Worker(...)` script opens; `tests/chromium.spec.ts` pins that against a live Chromium so a Playwright release that closes it turns the test red. HTTP requests from the same worker are intercepted, so this reaches WebSocket servers on private addresses only — a non-WebSocket service never completes the handshake and returns no data to the page. Closing it needs an upstream routing fix, or an injected `Content-Security-Policy` that this provider does not rewrite responses to add.
- **Only the transports Playwright routes are checked** — HTTP(S) requests and `ws:`/`wss:` connections pass the address policy. WebRTC data channels and WebTransport are not routed by Playwright, so a page's script could reach a destination over them; disabling those transports at launch is deferred work, and neither is reachable through the request or WebSocket interceptor today.
- **The install probe is a filesystem check** — it confirms that the executable a launch would run exists, not that it starts. A partial or broken installation still reports the provider as available, and the first fetch fails with the launch error and the install command instead.
- **The shipped route has no recorded-session lane** — the redirect refusal, the WebSocket refusal, the launcher, the probe, and the install command all run against a real Chromium in `tests/chromium.spec.ts`, including one end-to-end fetch that maps a fixture hostname to loopback so a whole render can run offline. A `snapshots/session/` scenario cannot do the same: the policy refuses loopback, so a fixture page it may fetch needs that launch-time host mapping, which a shipped profile has no place to state, and merely leaving the row mounted makes a scenario host-dependent, because the plugin warns at mount exactly when the host has no browser and that harness compares process stderr byte for byte. The recorded-session lane therefore runs the `http` route, and this route's evidence is the real-Chromium suite.
