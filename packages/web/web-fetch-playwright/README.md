---
description: "The Playwright Chromium rendered-page fetch backend for ctx.web: how deployments mount DOM-rendering URL retrieval with anonymous incognito contexts, one shared browser process, and bounded output."
kind: "package-reference"
---

# @deepseek-ai/dsh-web-fetch-playwright

English | [中文](README.zh.md)

## Summary

With `dsh-web-fetch-playwright`, the harness can fetch JavaScript-rendered pages through the web service (`ctx.web`): it loads each URL in a headless Chromium browser, waits for the DOM, and returns the serialized document. Choose it when a composition needs what plain HTTP retrieval cannot produce — the client-rendered DOM of single-page applications, pages that build their content with scripts, or any document whose meaningful markup exists only after execution. It stays anonymous like the HTTP backend: no credentials, no cookies carried between fetches, each render isolated in a fresh incognito context. Every request a page issues — main frame, subresources, and each redirect hop — passes the shared fetch URL policy and must reach a public unicast address. The model-facing `web_fetch` tool lives in `dsh-tool-web`, which renders this provider's bodies.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Behavior Boundaries](#behavior-boundaries)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the provider in a composition that already loads the web service; it registers as the `playwright` fetch provider. Because it costs a browser process, it is an explicit opt-in — pin it with `fetchProvider: playwright` so the service selects it only on request, and prefer `dsh-web-fetch-http` when pages render server-side.

### When to choose it

Choose this backend when a deployment must retrieve pages whose content is built by client-side scripts and the plain HTTP backend would return an empty shell: single-page applications, script-assembled documents, or pages that require a real DOM to produce their markup. It requires a Chromium installation (`playwright`'s browser binaries) on the host.

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

The provider accepts only `http:` and `https:` URLs without embedded credentials, under the shared fetch URL policy. It then intercepts every request the page issues and admits it only when its destination resolves to a public unicast address; a refused request is aborted as `blockedbyclient`, and a refused navigation target reports `WEB_BLOCKED_URL` before any browser work runs. One decision is memoized per hostname for the life of a fetch, so a page load resolves each host once.

Each fetch opens a fresh incognito context in one shared browser process, navigates with `domcontentloaded`, serializes the DOM, and closes the page and context; no cookies, storage, or authentication survive a fetch. At most `maxConcurrentRenders` fetches hold a context at once; the rest wait in arrival order and give up when their own deadline aborts.

The plugin probes the Chromium installation once while applying and logs a warning naming `playwright install chromium` when none is launchable, so the service reads real availability without probing per selection. The browser process itself launches lazily on first fetch and is reused; a launch that fails or a process that dies clears the memo so the next fetch retries. Disposal is terminal: it cancels the renders in flight, closes the process, and makes every later fetch fail with `WEB_PROVIDER_ERROR`.

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
- **Address policy at the browser edge.** Interception, not URL validation alone, is where the public-destination rule holds: a rendered page issues requests the caller never named, so the same policy decides the main frame, every subresource, and every redirect hop.
- **Two timeout layers.** The provider's `timeoutMs` is a resource backstop that also bounds Playwright's own navigation timeout; the model-facing tool-call budget belongs to `dsh-tool-call-timeout-policy`, which arms `exec.signal`. When the outer deadline fires first the provider reports `WEB_ABORTED` and the policy replaces it with `TOOL_TIMEOUT`; `WEB_FETCH_TIMEOUT` therefore identifies a service caller whose provider budget elapsed.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema, limit validation, provider registration, browser close on dispose |
| [`src/provider.ts`](src/provider.ts) | The `PlaywrightFetchProvider`: shared-browser lifecycle, incognito renders, DOM serialization |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; limits are enforced in the provider) |

### Read path

A fetch validates and admits the navigation target, takes a render slot, then reuses or launches the shared browser and opens a fresh incognito context. It installs the destination interceptor on that context before opening a page, navigates under the provider timeout with `domcontentloaded`, serializes the DOM, and closes the page and context before returning — so cleanup runs even when serialization fails. A dead or failed launch clears the memoized browser so the next fetch retries instead of pinning a broken process; a disposed provider refuses to launch at all.

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
- **Host browser dependency** — Chromium must be installed through `playwright`'s browser binaries; the plugin reports a missing installation as an apply-time warning and every fetch then fails with `WEB_PROVIDER_ERROR`.
- **Disposal is one-way** — a disposed provider never launches again, so a composition that unloads and remounts the plugin gets a new provider rather than a revived browser.

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
