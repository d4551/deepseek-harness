# Agent Note: LiteRT-LM route and Railway inference server

Status: implemented

English | [中文](2026-09-03-litert-lm-route-and-railway-server.zh.md)

## Problem

LiteRT-LM ships a Python CLI whose `serve` subcommand exposes an OpenAI-compatible HTTP API, so the harness needs nothing new to *talk* to it — [`@deepseek-ai/dsh-llm-pi-ai`](../../../../packages/llm/llm-pi-ai/README.md) already serves hand-declared `openai-completions` gateways over an arbitrary base URL. What no existing package owns is everything around the wire: importing multi-gigabyte `.litertlm` models into the CLI's registry, starting `litert-lm serve` as a supervised child, waiting for it to answer before any request is routed to it, and stopping it on dispose. A composition that wanted a local LiteRT model had to start the server by hand and hope the harness never outlived it.

## Decision

[`@deepseek-ai/dsh-llm-litert`](../../../../packages/llm/llm-litert) owns LiteRT-LM's model and process lifecycle and delegates every request to pi-ai. `apply` resolves its config, brings the endpoint up when this composition owns the server, then constructs a `PiAiAdapter` over a profile whose `api` is `openai-completions`, whose `baseURL` is the resolved endpoint, and whose `models[]` is the configured catalog — the same declaration a deployment writes by hand for any other OpenAI-compatible gateway. `ctx.llm.registerAdapter([provider], adapter)` publishes it. No HTTP client, streaming decoder, or message conversion lives in this package.

Both postures are first class and structurally distinguishable. schemastery materializes an absent nested object with every default filled, so a `server?:` key cannot be told apart from an unset one; `server.cwd` — the one supervision field with no defensible default — is therefore what selects local supervision. `baseURL` alone means remote: nothing is spawned, nothing is imported, and a `huggingFaceRepo` beside it is refused, because that would promise an import this route never performs. Naming both, or neither, fails at load.

`LitertServer` is the whole readiness path. It resolves the executable through `ctx.subprocess.resolveExecutable`, reads the registry with `litert-lm list`, runs `litert-lm import [--from-huggingface-repo REPO] FILE ID` for each configured model the registry does not already hold, spawns `litert-lm serve --host --port`, and polls `GET /v1/models` until the server answers. The registry, not a file path, is the authority on presence: `import` writes into `$HOME/.litert-lm`, not to a caller-chosen path, so a path probe could never observe what an import produced. Every budget is a validated config field — `importTimeoutMs`, `startupTimeoutMs`, `healthIntervalMs`, `shutdownGraceMs`, `maxStderrBytes` — and each failure quotes the child's retained output. A wait that ends in a timeout, a caller abort, or an early exit terminates the process before it throws, so a failed `apply` leaves nothing behind; the success path registers teardown as a `ctx.effect()` disposer that runs after the route is withdrawn.

Two facts about pi-ai were load-bearing and are recorded here because both contradict the obvious reading of its source.

**Mounting `llm-pi-ai` as a child plugin is unsafe.** It would have been the smallest delegation — `ctx.plugin(PiAiPlugin, { providers })` reuses the settings section, the credential resolution, and the configurable-provider directory for free. But `llm-pi-ai` installs the `llm-pi-ai` settings namespace, and [`SettingsProvider.register`](../../../../packages/settings/settings/src/index.ts) throws `settings namespace "…" is already registered` on a duplicate. A composition that mounted both plugins — the ordinary case, since LiteRT serves one route and pi-ai serves the rest — would fail to boot. Constructing `PiAiAdapter` directly is what lets the two coexist.

**pi-ai's `openai-completions` request path requires a non-empty key.** Its `getClientApiKey` returns the request's key, or the literal `"unused"` when an `Authorization` header is already present, and otherwise throws `No API key for provider`. A route omitting `apiKeyEnv` is supported at *configuration* time and by endpoint interrogation, but a stream call from such a route never reaches the network. LiteRT-LM's server authenticates nothing, so this package's `resolveApiKey` returns pi-ai's own `'unused'` placeholder unconditionally. It is a constant of that client, not a deployment choice, and it is why the package exposes no credential option: a LiteRT endpoint that did check credentials would not be this route.

`llm-pi-ai` publishes `./auth` and `./config` subpath exports, each built as its own bundle by a package-local `tsdown.config.ts` and listed in `files`, so `llm-litert` reaches `resolveProfiles`, `credentialStoreFrom`, and `authContextFrom` in the modules that own them. The alternative that first shipped — re-export lines on `llm-pi-ai`'s entry module — widened one module's reach through another and is banned.

## Railway deployment

[`deploy/litert/`](../../../../deploy/litert/README.md) defines a Railway service running the same server the local posture supervises, for compositions that point at it with `baseURL`. The image is `python:3.12-slim` plus `pip install litert-lm` and carries no model layer: a `.litertlm` file is gigabytes, and an image layer would be re-pulled on every deploy while the volume already holds it. `entrypoint.sh` imports the configured model on first start and then binds Railway's injected `$PORT`, never the CLI's `9379` default, which would leave the service unreachable and failing its own health check. `HOME` points at the volume mount, because the CLI resolves its registry as `$HOME/.litert-lm` and that indirection is what makes an imported model survive a redeploy. Railway's config schema has no `volumes` key, so `railway.json` declares the requirement as `deploy.requiredMountPath` and the volume itself is created on the service; `numReplicas` is `1`, since a volume attaches to one replica.

## Alternatives considered

**Write a second OpenAI-completions HTTP client.** Rejected outright: `llm-pi-ai` already implements the protocol, its streaming, and its message conversion, and a LiteRT-specific copy would be a second implementation of the one thing this package does not own.

**Mount `llm-pi-ai` as a child plugin.** Rejected for the settings-namespace collision described above. It also would have made the LiteRT route editable through the `llm-pi-ai` user-settings section, where a human edit could repoint `baseURL` away from the process this plugin supervises.

**Declare the route by writing into the `llm-pi-ai` settings section.** Rejected because that section is the user's document. A composition-owned route would appear as a user override, survive the plugin's disposal, and outlive the server it names.

**Probe a configured `.litertlm` path to decide whether to import.** Rejected because `litert-lm import` copies into the registry rather than to a caller-chosen path, so the configured path would still be absent after a successful import and every start would re-download. `litert-lm list` is the documented way to see what the registry holds, and the header row it prints cannot collide with a configured id in any way that matters: a false match only skips an import the server then fails on, loudly.

**Reach `llm-pi-ai`'s internals through its `./src/*` export.** Rejected because that specifier survives into the published bundle verbatim — `tsdown` externalizes it — leaving a built package importing a `.ts` file that plain Node cannot load. Real subpath exports resolve to `lib/*.js`, which is what [`web-fetch-http`](../../../../packages/web/web-fetch-http/package.json) already does for `./policy` and `./network`.

**Give the route an `apiKeyEnv` for deployments behind an authenticating proxy.** Rejected for want of a consumer: LiteRT-LM has no credential, and a configurable one would invite a deployment to believe this package authenticates something it does not.

## Consequences

A composition gains a local LiteRT model by naming `server.cwd` and its models, and gains a hosted one by naming `baseURL`; nothing else in the harness changes, and the DeepSeek and pi-ai routes are unaffected. The cost is that `llm-litert` is coupled to `llm-pi-ai`'s adapter construction rather than to a narrower seam: `PiAiAdapterOptions` is a same-repository contract, so a change to it reaches this package at compile time rather than at runtime, but it is a contract two packages now hold rather than one.

Boot is slower and can fail where it previously could not. The local posture blocks `apply` until the server answers, so a first start that downloads a model takes as long as the download and a server that never becomes healthy fails the composition instead of degrading it. That is the intended trade: a route registered against a dead endpoint would fail every request with a network error that names nothing.

`llm-pi-ai` now publishes two more entry points and carries a package-local build config, so its `files` array needs the [constraints allowlist entry](../../../../scripts/check-workspace-constraints.ts) that every package with extra bundles carries.

## Testing

[`packages/llm/llm-litert/tests/litert.spec.ts`](../../../../packages/llm/llm-litert/tests/litert.spec.ts) injects the subprocess spawner, the executable resolver, and the health probe, and drives the real `LitertServer` and the real plugin. It pins the import-skip and import-run decisions, the argv of every `litert-lm` invocation, a failed import and a failed `list`, an import that outlives its own timeout, a startup that never becomes healthy (terminating the process within the configured budget), a serve process that exits during startup, caller cancellation, and every configuration rejection. The remote posture is pinned by asserting that the route registers on `ctx.llm` while the recording subprocess service saw no spawn at all.
