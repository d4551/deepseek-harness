# Agent Note: The bash and pwsh surfaces share one implementation

Status: implemented

English | [中文](2026-09-03-bash-pwsh-parallel-surfaces.zh.md)

## Problem

Eight packages implemented the `ctx.shell` seam and its two model-facing tools as two families — `bash-local`/`pwsh-local`, `bash-sandbox`/`pwsh-sandbox`, `tool-bash`/`tool-pwsh`, `tool-bash-persistent`/`tool-pwsh-persistent`. Each pwsh package carried a comment declaring itself a "deliberate call-for-call mirror" of its bash twin, and those comments doubled as `jscpd:ignore` markers, so the clone gate never reported the pairs. With the markers removed, the four pairs reported 35 clones over roughly 918 lines: the largest cluster in the repository.

The mirror claims were not evidence. Diffing the regions showed that almost none of the duplication was a platform difference. The real platform differences are small and enumerable: `bash -c <command>` versus `pwsh -NoLogo -NoProfile -NonInteractive -Command <preamble><command>`, `TERM=dumb` (a POSIX concept pwsh has no use for), pwsh executable resolution and its UTF-8 output preamble, the diagnostic prefix each provider stamps on its own errors, and — for the persistent PTY tools — command wrapping, quoting, prompt handling, and the model-facing shell names. Everything else was a copy.

## Decision

`@deepseek-ai/dsh-shell`, the Service Definition package both families already depend on, owns what every dialect states identically. The dialect packages keep only what actually differs.

**Providers.** `SubprocessShellExecutor` (`@deepseek-ai/dsh-shell/subprocess-executor`) implements the whole `ctx.shell` provider: settings-section installation, `resolve` defaulting and capping, the spawn spec, collect-reader projection, the fused deadline and first-cause classification, the background handle with its consuming read merge and single-delivery spawn-failure note, and the optional `ctx.sandbox` confinement layer. A provider supplies a `ShellDialect` (`label`, `envOverrides`) and one `argv(spec)` method. `dsh-bash-local` fell from 328 to 70 lines and `dsh-pwsh-local` from 360 to 125; `pwsh-local` additionally overrides `onConfigChange` because its resolved executable is the one fact it derives from the config.

**Confinement.** `ShellConfinement` holds the per-process facts a confined run settles against, converts positive runner-launch evidence into `SANDBOX_UNAVAILABLE`, and stamps `mode`/`denied`/`enforcement`/`runnerFailed`. It reads two members from the deployment's policy service through the local `ShellSandboxPolicy` interface, which `ctx.sandboxPolicy` satisfies structurally, so the seam gains no dependency on `@deepseek-ai/dsh-sandbox-policy`. `dsh-bash-sandbox` and `dsh-pwsh-sandbox` are now a class declaration, an `inject` list, and one `confineThrough({ sandbox, policy })` call: 182 and 189 lines became 46 and 53.

**Tools.** The seam owns the model-facing text and call contract both tools publish: `renderShellResult` and `renderShellProcessRead` (with `parseExitStatus`, already there, as their inverse), `processOutcome`, `validateShellToolArgs`, `canonicalShellResult`, the `timeoutMs`/`workdir`/`run_in_background`/`sandbox_permissions`/`justification` parameters, `SHELL_TOOL_OUTPUT_SCHEMA`, and `SHELL_ESCALATION_GUIDANCE`. Not one model-visible byte changed: `gen-tool-catalog --check` reports the committed catalog — which pins both tools' descriptions, parameters, and output schemas — still up to date. Each tool package states only its own dialect: tool name, command vocabulary, the platform note pwsh adds about force-killed processes, its prompt section, and its workdir resolution.

Two pwsh comments were true and are preserved as behavior: `TERM` stays out of the pwsh environment because it is a POSIX concept, and the pwsh argv keeps `ENCODING_PREAMBLE` because Windows PowerShell 5.1 writes the console code page by default. Everything else the mirror comments justified is now one definition.

## What the generator constrains

[`scripts/gen-config-catalog.ts`](../../../../scripts/gen-config-catalog.ts) walks each plugin entry's `static Config` literal statically, so each provider still names the keys it accepts: a spread of shared fields makes the walk report `schema object property '...subprocessShellConfigFields()' is not a plain key`, and the catalog then states no accepted fields for that plugin. Naming a key and taking its schema from elsewhere is fine — the walker records the key and ignores the value expression — so `subprocessShellConfigFields()` supplies every shared field, including its default, and each provider's literal is a key list two lines long. Nothing about the config is written twice.

## The Consumer twins

The tool Consumer layer had the same problem and no package to own it: `tool-bash` ↔ `tool-pwsh` shared `presentCall`, `presentResult`, the escalation approval wrapper, the `apply()` preamble, and the `execute` body, and the persistent pair shared its whole session registry, polling loop, and capture rendering. Moving that into `@deepseek-ai/dsh-shell` would make the seam — and every executor provider that depends on it — require `@deepseek-ai/dsh-tools`, `@deepseek-ai/dsh-jobs`, `@deepseek-ai/dsh-agent`, `@deepseek-ai/dsh-terminal`, and `@deepseek-ai/dsh-user-approval`. The twins were collapsed instead, by the [one-shell-tool-per-role note](../architecture/2026-09-03-one-shell-tool-per-role.md): `@deepseek-ai/dsh-tool-shell` and `@deepseek-ai/dsh-tool-shell-persistent` register either dialect from one implementation, and `dsh-tool-shell` consumes the rendering, parameters, output schema, argument checks, and escalation guidance this note moved into the seam.

## Alternatives considered

**Put the shared Consumer code in `dsh-tool-bash` and import it from `dsh-tool-pwsh`.** Rejected for the reason the [pwsh UI parity note](../feature/2026-08-05-pwsh-ui-bash-parity.md) already recorded: a sibling tool depending on its twin inverts the package relationship and puts `tool-bash` in every closure that deliberately mounts only the pwsh tool.

**Give `dsh-shell` the tool-layer dependencies and move everything.** Rejected: `packages/AGENTS.md` keeps tool-schema and presentation in the Consumer, and a seam whose peer set includes the tool registry, the job runtime, and the agent spine makes a leaf executor provider pull the product spine.

**A mixin (`confining(Base)`) so each sandbox executor keeps extending its own local executor.** Rejected: TypeScript mixins over an abstract base need `any[]` constructor parameters and produce an unnameable return type under declaration emit. Installing the confinement layer on the shared base instead keeps both hierarchies and one implementation.

**Keep the sandbox executors extending `SubprocessShellExecutor` directly instead of their local twins.** Rejected: `SandboxPwshExecutor` would have to repeat `pwsh-local`'s executable resolution, trading one clone for another.

**Leave the config-schema literals shared and regenerate the catalog.** Rejected: the generator refuses the file rather than emitting a partial entry, and teaching it a new schema form is a `scripts/` change outside this change's scope.

## Testing

`renderResult`/`renderPwshResult`, `renderProcessRead`/`renderPwshProcessRead`, and both `processOutcome` suites moved from the two tool packages into `packages/shell/shell/tests/render.spec.ts` and `packages/shell/shell/tests/background.spec.ts`, merged so every assertion from both sides survives — the bash cases plus the pwsh suites' exact-string denial, escalation-hint, and runner-failure expectations, and a Windows spill path beside a POSIX one. Each tool's `presentResult` round-trip stays in its own package, now driving the shared renderer, because it pins that tool's presenter against the marker contract.

`bash-sandbox`'s three fact-leak assertions read `confinement.processFacts` instead of `processFacts`: the same map, the same assertion, one owner further in.

## Consequences

`@deepseek-ai/dsh-shell` gains `@deepseek-ai/dsh-timeout` as a peer dependency and `@deepseek-ai/schemastery` as a dependency, and publishes a `./subprocess-executor` subpath with its own `tsdown` entry. That bundle imports the package root, so it carries a second copy of the Service Definition; the seam holds no mutable state and registers services by name, so the copy changes nothing a caller can observe.

The config catalog now shows `dsh-bash-local`'s config as `export type Config = SubprocessShellConfig` with a link to the seam, the same shape `dsh-bash-sandbox` already had.

Clone-gate result for `packages/shell`: 35 clones over 883 duplicated lines became none.
