---
description: "The LiteRT-LM route for ctx.llm: how deployments serve local .litertlm models, either by supervising litert-lm serve or by pointing at an already-running server, while pi-ai speaks the wire protocol."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-litert

English | [中文](README.zh.md)

## Summary

With `dsh-llm-litert`, a composition can serve LiteRT-LM models through the LLM service (`ctx.llm`). The package owns the two things an OpenAI-compatible client cannot do for LiteRT-LM: importing `.litertlm` files into the `litert-lm` registry and supervising the `litert-lm serve` process. Requests themselves are delegated — the plugin registers the resolved endpoint and model catalog as a pi-ai `openai-completions` provider profile, so no HTTP client, streaming decoder, or message conversion lives here. Choose it to run models on the deployment's own hardware, either inside the harness process tree or behind a server someone else started.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Model Experience](#model-experience)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount the plugin in a composition that loads the LLM service; it registers one route key on `ctx.llm` under the `provider` you name. A route is either remote or locally supervised, and the two are mutually exclusive.

### Choose a posture

Set `baseURL` to point at an already-running LiteRT-LM server — a container, a Railway service, a server started outside the harness. Nothing is spawned and nothing is imported, so `server.cwd` must be absent and no model may name `huggingFaceRepo`.

Set `server.cwd` to supervise a local server instead. The plugin imports every configured model, starts `litert-lm serve`, waits for `GET /v1/models` to answer, and terminates the process when the plugin is disposed. Setting both, or neither, fails at load with a message naming the two keys.

### Minimal configuration

```yaml
- id: llm
  name: '@deepseek-ai/dsh-llm-litert'
  config:
    provider: litert
    models:
      - id: gemma4-e2b
        file: gemma-4-E2B-it.litertlm
        huggingFaceRepo: litert-community/gemma-4-E2B-it-litert-lm
        contextWindow: 32768
        maxTokens: 4096
    server:
      cwd: /var/lib/litert
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | required | Route key registered on `ctx.llm` |
| `displayName` | `provider` | Name configuration surfaces show for the route |
| `models` | required | Models the route serves, in configuration order |
| `baseURL` | — | Endpoint of an already-running server, including its `/v1` prefix |
| `server.cwd` | — | Working directory for the `litert-lm` children; setting it selects local supervision |
| `server.command` | `litert-lm` | Executable resolved through the subprocess service's execution world |
| `server.host` | `127.0.0.1` | Address passed to `--host` and connected to |
| `server.port` | `9379` | Port passed to `--port` |
| `server.startupTimeoutMs` | `120,000` | Budget for the server to answer `GET /v1/models` after it is spawned |
| `server.importTimeoutMs` | `1,800,000` | Budget for one `litert-lm import`, sized for multi-gigabyte downloads |

Each model names its `litert-lm` registry id, the `.litertlm` file, and the capacities the harness sizes context management from. The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-litert) is the exhaustive source for every accepted field and its JSDoc.

### Deploying the server separately

[deploy/litert](../../../deploy/litert/README.md) defines a Railway service that runs the same `litert-lm serve` in a container. A route pointed at that service's public domain plus `/v1` uses the remote posture.

### Failures at load

Configuration resolution runs before any import, so an unserviceable model list fails without first paying for a multi-gigabyte download. A duplicate model id, an empty id or file, a `huggingFaceRepo` on a remote route, a non-`http`/`https` `baseURL`, or a health interval larger than the startup budget each fail with a message naming the key. A supervised route additionally fails if the executable cannot be resolved, the import does not finish inside `importTimeoutMs`, or the server does not answer within `startupTimeoutMs`; the retained stderr tail is quoted in the failure.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the route; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **Lifecycle here, protocol elsewhere.** LiteRT-LM speaks the OpenAI completions wire protocol that `dsh-llm-pi-ai` already implements. This package therefore contributes only the process and the model files, and hands pi-ai a provider profile carrying the endpoint and catalog. A wire-protocol change is pi-ai's to make.
- **One explicit resolve step.** `resolveConfig()` is the package's only defaulting point. It decides the posture, validates every key, and returns a `ResolvedLitertConfig` that downstream code reads without re-deciding anything.
- **`server.cwd` selects the posture.** Schemastery materializes an absent `server` object with every default filled, so the one field that can have no sensible default is what distinguishes a configured supervision block from an unset one.
- **A placeholder credential is a protocol constant.** LiteRT-LM authenticates nothing, but pi-ai's OpenAI-completions client refuses to build a request without a key, so a fixed non-secret placeholder rides in the header and the server ignores it.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: posture branch, pi-ai profile construction, adapter registration |
| [`src/config.ts`](src/config.ts) | Config schema and `resolveConfig()`, the one explicit resolve step |
| [`src/server.ts`](src/server.ts) | `LitertServer`: model import, `litert-lm serve`, and the startup health wait |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; the durable request relations belong to the LLM service) |

### Startup and disposal

A supervised route imports its models, spawns the server through `ctx.subprocess`, and polls `GET /v1/models` every `healthIntervalMs` until it answers or `startupTimeoutMs` elapses. Startup work observes the plugin's own disposal, because an async plugin callback must abort itself before Cordis can run effect cleanup. A start that fails disposes the process it may have spawned, since the teardown effect is not registered yet. The adapter registration is bound to the calling fiber, so disposal removes the route before the process is stopped.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [LLM package map](../README.md) — the group and each package's role.
- [dsh-llm](../llm/README.md) — the service this route registers into.
- [dsh-llm-pi-ai](../llm-pi-ai/README.md) — the adapter that speaks the wire protocol for this route.
- [dsh-subprocess](../../subprocess/subprocess/README.md) — the execution world the server process runs in.
- [deploy/litert](../../../deploy/litert/README.md) — a container deployment of the same server for the remote posture.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-llm-litert) — every accepted config field and its source declaration.

-----

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define what the route does not attempt; they are current package contracts.

- **One route per plugin instance** — a composition serving several LiteRT-LM endpoints mounts the plugin once per route, because `provider`, `models`, and the endpoint resolve together.
- **The supervised server is not restarted** — the plugin starts the process once and stops it on dispose; a server that exits later leaves the route registered and its requests fail through pi-ai until the fiber is reloaded.
- **Imports are load-time only** — models are imported while the plugin applies, so adding a model means changing configuration and reloading, not calling the running server.
- **The endpoint is unauthenticated** — LiteRT-LM's HTTP API has no credential of its own, so a remote route must reach a server that is private or fronted by an authenticating proxy.

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

Indirectly, through `dsh-llm-pi-ai`, which owns every request this route's profile is sent with.

#### KV Cache effect

No direct invalidation; the delegate adapter and the request assembly own any prefix change.
