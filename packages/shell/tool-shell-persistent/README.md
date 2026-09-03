---
description: "The model-facing persistent shell tool for users and maintainers choosing, configuring, or debugging owner-scoped bash or PowerShell state that survives across calls."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shell-persistent

English | [中文](README.zh.md)

## Summary

`dsh-tool-shell-persistent` gives the agent a shell tool whose state persists across calls for the owning agent: cwd, exported or `$env:` variables, functions, and background jobs survive between commands. The required `dialect` config selects which shell the mount drives — `bash` registers a `bash` tool, `pwsh` registers a `pwsh` tool — and with it the command wrapping, quoting, prompt handling, and default description. Each agent gets its own shell backed by an owner-scoped PTY session from the terminal service, and commands for the same agent run one at a time. Configuration also selects the PTY backend and the wall-clock limit for one command; a timeout or an explicit `exit` closes the shell, and the next call starts fresh. It complements the one-shot `dsh-tool-shell` tool — choose it when work needs cross-call state. Mount it together with a terminal backend whose shell matches the dialect, such as `dsh-terminal-bash`, and the `ctx.terminals` service.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Load this plugin in any composition where the agent should keep shell state between commands — for example long build sessions, activated environments, or scripts that export variables for later steps. It registers the tool named by its `dialect` and requires the `ctx.tools` and `ctx.terminals` services plus an owning agent session at execution time.

### When to choose it

Choose the persistent tool when work depends on cross-call state: a one-shot `dsh-tool-shell` call cannot remember a `cd` or an exported variable. Choose the one-shot tool when every command should start from a known, clean environment, or when the command is short and self-contained. Commands that need interactive stdin are unsupported here — a foreground child that reads input blocks until the command timeout — so interactive work belongs to the terminal tools.

### Choosing the dialect

`dialect` has no default: state it, and state the shell the PTY backend actually starts. The dialect chooses the tool name, the wrapper that brackets a command and reports its status, and — for pwsh — the private prompt this tool installs over the backend's. A bash-dialect mount over a pwsh backend would submit bash wrapper syntax to PowerShell and never see a completion marker. Mount the plugin once per composition.

### Minimal configuration

The default `shell` backend starts an interactive bash through `dsh-terminal-bash`; deployments may register another PTY backend and select it by name.

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-shell-persistent'
  config:
    dialect: bash
```

| Field | Default | Meaning |
|---|---|---|
| `dialect` | required | `bash` or `pwsh`: the tool name, command wrapping, prompt handling, and default description |
| `backendType` | `shell` | Registered PTY backend used for each agent's shell |
| `timeoutMs` | `300,000` | Wall-clock limit for one command; timeout closes the shell |
| `maxOutputChars` | `16,000` | Maximum retained command-output characters; fixed diagnostics are added afterward |
| `description` | the selected dialect's | Model-facing environment contract; deployments may describe their environment |

The two dialect defaults are `Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.` and `Run commands in a persistent PowerShell shell. State, including the current directory and exported environment variables, persists across calls for this agent.`

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-shell-persistent) is the exhaustive source for every accepted field and its JSDoc.

### What the agent can rely on

Commands share one shell per agent, so state persists until an `exit`, a timeout, or a reset — each of which closes the shell and tells the agent the next call starts from the workspace with a fresh directory and environment. Results exclude the private completion markers; a non-zero wrapped command appends `[exit code: N]`, and a shell that exits before reporting that status instead appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]`, then resets. Long output keeps the earliest retained prefix plus a clipping notice; if the terminal has already dropped that prefix, the result says so explicitly rather than presenting a tail as complete output.

### What can go wrong

A call without an owning agent session fails with `<dialect> requires an owning agent session`, a mount with no `dialect` fails config validation at load, and a composition without a PTY backend activates the tool but fails its first call with `no PTY backend registered for "shell"`. An interactive foreground child (for example a REPL) returns early with partial output only where the backend proves its stdin wait; elsewhere the call runs to `timeoutMs`, which closes the uncertain shell and reports the reset. Cancellation also resets and discards the result, even when a complete status marker is already observable.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the tool and points at the code that realizes them; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

- **One shell per owner, nothing shared.** The shell registry keys every session by the calling `Agent`, so concurrent agents never share state, and commands for the same agent are serialized through a per-owner queue.
- **Marker-anchored extraction.** Each command is wrapped with unique start/end markers carrying the exit status; the tool polls the PTY scrollback and extracts the span between the real markers, so prompts and echoed input never leak into results. The wrapper carries the call's own nonce, so any occurrence of it in captured text is this call's echo and is stripped.
- **One implementation, one dialect record.** The session registry, polling loop, scrollback assembly, capture rendering, and reset contract have one definition; [`src/dialect.ts`](src/dialect.ts) holds the only per-shell facts ([one shell tool per role Agent Note](../../../.agents/notes/implemented/architecture/2026-09-03-one-shell-tool-per-role.md)).
- **Reset, never repair.** Any uncertain state — an explicit `exit`, a timeout, a send failure, an abort — closes the shell and starts the next call fresh, because a half-known shell is worse than a clean one.
- **Owner-scoped lifecycle.** Shells are created lazily on first use and killed on plugin disposal or owner teardown; the owner-scoped `ctx.terminals` service fences every operation to the owning agent.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: shell registry, scrollback polling, extraction and rendering |
| [`src/dialect.ts`](src/dialect.ts) | Per-shell facts: tool name, marker names, wrapper and quoting, setup input, prompt, completion detection, model-facing text |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; shell reuse is observable through tool execution) |

### Command flow

A first command spawns the shell through `ctx.terminals.spawn`, submits the dialect's setup input, and waits for readiness: bash disables input echo (`stty -echo`) and keeps the backend's own prompt, while pwsh installs a private prompt because PSReadLine has no echo switch. Each command is then wrapped into one physical line — for bash a printf of the start marker, the command body escaped with `$'…'`, and a printf of the end marker plus `$?`; for pwsh a `Write-Output` of the start marker, an `Invoke-Expression` of the backtick-escaped body, and a `Write-Output` of the end marker plus the resolved `$LASTEXITCODE` — so embedded newlines cannot leak terminal prompts into the result. The tool polls the scrollback in 1,000-line pages until the end marker appears, extracts the span, and renders it with any status marker. Where no end marker arrives, the dialect decides that the command settled: bash on the backend's `stdin_read` wait reason, pwsh on its own prompt reappearing in the viewport. A timeout aborts the deadline, captures the partial output, and resets the shell.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the terminal family to the seam, the backends, and the design note behind owner-scoped sessions.

- [terminal package map](../../terminal/README.md) — the persistent PTY capability family.
- [terminal seam](../../terminal/terminal/README.md) — the `ctx.terminals` service behind the tool.
- [terminal-bash backend](../../terminal/terminal-bash/README.md) — the default `shell` backend, which also serves the pwsh dialect through its `shellDialect` config.
- [one shell tool per role Agent Note](../../../.agents/notes/implemented/architecture/2026-09-03-one-shell-tool-per-role.md) — what the dialect config selects and what genuinely differs between the shells.
- [tool-terminal](../../terminal/tool-terminal/README.md) — six model-facing terminal tools for interactive work.
- [Persistent PTY sessions Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.md) — the owner-scoped session design and its rationale.
- [Generated tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shell-persistent) — the exact `bash` and `pwsh` argument schemas.
- [Generated configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-tool-shell-persistent) — every accepted config field and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Tool schema

#### What the model sees

The generated [`bash` or `pwsh` schema](../../../docs/tool-catalog.md#deepseek-aidsh-tool-shell-persistent) for the mounted dialect — never both, because one mount registers one name — including the configured `description`. The plugin contributes no standalone system-prompt section; the deployment owns persona and environment guidance.

#### Token effect

Fixed schema cost while the tool is visible.

#### KV Cache effect

Prefix-stable while the dialect, the configured description, and the schema remain unchanged.

### Tool results

#### What the model sees

Commands share one shell per Agent, so cwd, exported or `$env:` variables, activated environments, functions, and background jobs persist across calls. Results exclude private completion markers and, under the pwsh dialect, the private prompt and any echoed wrapper source. When the command settles without a completion marker — after `exec`, an interrupt, or an interactive foreground child whose stdin wait the bash backend proves, or the pwsh prompt reappearing — the call returns the captured partial output, which under the bash dialect can end with the backend's own prompt text. A nonzero wrapped command appends `[exit code: N]`; a shell that exits before reporting that status instead appends `[shell exited: code N]`, `[shell killed by signal: SIG]`, or `[shell exited]` when the backend supplies neither, then resets and tells the model that the next call starts fresh. Long output keeps the earliest retained prefix plus a clipping notice. If the PTY has already dropped that prefix, the result says so explicitly instead of presenting a tail as complete output. Timeout returns bounded partial output, closes the uncertain shell, and reports the reset.

#### Token effect

Data-dependent. `maxOutputChars` bounds retained command output; fixed clipping, lost-prefix, status, timeout, and reset diagnostics can extend the result.

#### KV Cache effect

Append-only tool results follow the reusable request prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the tool is a poor fit or needs special care. They are current package constraints, not a task backlog.

- **The tool requires an owning Agent and a real PTY backend whose shell matches the dialect** — agent-less calls, a dialect-mismatched backend, and backends that cannot start an interactive shell fail.
- **The pwsh dialect cannot suppress input echo** — PowerShell's PSReadLine renders submitted input back into the terminal stream and has no `stty -echo` equivalent. The marker-anchored extraction excludes the echo in complete results, and the wrapper-source strip covers fallback paths, but a wrapper that wraps across the terminal width may leave a partial echo in partial-output results, bounded by `maxOutputChars`.
- **Raw ESC characters inside pwsh commands are unsupported** — PSReadLine consumes them before execution. The wrapper escapes the control bytes it needs (`[char]27`-built OSC markers, backtick escapes for the body).
- **A model redefinition of the pwsh `prompt` function removes the readiness marker** — the shell then settles on the silence tier instead of the marker fast path.
- **SIGTSTP/SIGHUP are unavailable on Windows** (backend-rejected); SIGINT is delivered as a console-wide Ctrl-C input write, which at a prompt cancels the pending line instead of signalling a process.
- **An interactive foreground child returns early with partial output only where the subprocess provider proves its stdin wait** — elsewhere the call runs to `timeoutMs`.
- **Explicit `exit` and timeout discard shell state** — cancellation also resets and discards the result, even when a complete status marker is already observable; the next call starts a fresh shell.
- **Environment facts such as network access and package mirrors belong in the configured `description`** — not this package's default.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
