# Agent Note: Forward the parent's workspace roots to every out-of-process child

Status: implemented

English | [中文](2026-09-03-out-of-process-child-workspace-roots.zh.md)

## Problem

An in-process child inherits its parent's complete workspace: `childSessionMeta` copies the `cwd` and `appendDelegatedSessionState` writes the parent's additional roots onto the child's own log ([swarm reachability and child roots](2026-09-03-swarm-reachability-and-child-roots.md)). The four out-of-process providers handed the child its `cwd` and nothing else, so a parent working across several folders silently narrowed each foreign child to one of them — its sandbox write fence, search coverage, and per-root instruction loading all collapsing in the middle of a task the parent had scoped wider.

Two of the four READMEs justified the narrowing with a claim about the child products that is false. Claude Code's Agent SDK accepts `Options.additionalDirectories`, and Codex's `thread/start` accepts per-thread config overrides including `sandbox_workspace_write.writable_roots`; neither product takes its workspace only from its own configuration. ACP's `NewSessionRequest` has carried `additionalDirectories` beside `cwd` since before the pinned SDK version, so the "single `cwd`" claim was false as well. `subagent-dsh-sdk` drives this repository's own SDK, where the only obstacle was that `InitializeParams` had no field for the roots.

## Decision

**One resolve step in the seam, one forwarding mechanism per product.** `resolveChildWorkspaceRoots(parent, childCwd)` joins `resolveChildCwd` in `dsh-subagent/out-of-process`: it returns `sessionWorkspaceRoots(parent.session)` minus the child's own resolved `cwd`. Each provider calls it in `start()` and stores the result on its run spec, so defaulting stays an explicit resolve step in the owning implementation rather than a `??` inside a driver.

The parent's own `cwd` is deliberately absent from the result. Without a `cwd` override the child already runs there, and with one the deployment has stated where the child works — re-adding the parent's directory would widen a deliberately pinned child's write fence past its configuration. The `childCwd` filter therefore only removes an override that lands on one of the parent's own additional roots, which is that child's primary root rather than an additional one. Roots are compared by exact spelling, the identity `setAdditionalWorkspaceRoots` records them under; canonicalization belongs to the child's own enforcement layer.

**A forwarded root set is confirmed, never assumed.** Two of the three foreign interfaces can drop the field silently, and a child running in a narrower workspace than the parent recorded is the failure this work exists to remove — so neither is sent hopefully.

ACP negotiates: `SessionCapabilities.additionalDirectories` is `{}` when supported, and both an omitted key and an explicit `null` mean unsupported. When the parent has additional roots and the child's `initialize` response does not advertise it, the delegation is refused at that response — the earliest point the advertisement exists — with `stage: new-session; category: configuration`. The cause names the configured agent command and the roots it cannot take, so the operator can act; the model-visible text stays the package's fixed safe fact.

Codex does not negotiate, but it acknowledges. An unrecognized key in `thread/start`'s `config` map is ignored without an error — unlike the CLI's `--strict-config`, which rejects one loudly — so a renamed key in a future version would narrow the child with no signal. `ThreadStartResponse.sandbox` reports the merged policy, so the acknowledgement is checkable: when roots were declared and the returned policy is `workspaceWrite`, every declared root must appear in its `writableRoots`. Under `dangerFullAccess` the child may write anywhere and under a read-only or external policy the list is not the mechanism the deployment chose, so neither is treated as a forwarding failure.

Claude Code and the DSH SDK need neither. `Options.additionalDirectories` is a plain launch option on an exact-pinned direct dependency, so its absence is a compile error rather than a silent drop, and the restrictive-only filtering documented near it applies to `managedSettings`, which this provider never passes. The DSH SDK server is ours and records what it is given.

An empty root list sends nothing. This is not cosmetic for Codex: `thread/start`'s `config` map is an override, so a `writable_roots` entry carrying an empty list would replace a deployment's own configured roots with none. The same rule holds everywhere for symmetry, and each provider's existing exact-payload test pins the unchanged single-root request.

**Each product receives the roots through the list it already has.**

- `subagent-claude-code` sets `Options.additionalDirectories`, the official Agent SDK's own equivalent of the CLI's `--add-dir`.
- `subagent-codex` adds `config: { 'sandbox_workspace_write.writable_roots': [...] }` to `thread/start`. The thread-scoped config override is used instead of the structured `sandboxPolicy`, which would force this provider to restate the deployment's network, tmpdir, and `/tmp` settings as hardcoded values to change one field.
- `subagent-acp` adds `additionalDirectories` to `session/new`.
- `subagent-dsh-sdk` gains a wire field, because the child is this repository's own runtime. `InitializeParams.additionalDirectories` is optional and absolute-only; `HarnessSdkJsonRpcServer` validates it at the handshake — before any session exists, the same point `session.create` rejects a bad root — and records it on every SDK-created session through `setAdditionalWorkspaceRoots`. `DeepSeekHarnessOptions.additionalDirectories` resolves each entry against the calling process for the same reason `cwd` does: the child re-resolves nothing.

The roots stay a log fact on the SDK child, as they are everywhere else: the header carries `cwd` alone, the child's own `workspace/roots` event carries the set, and a cold resume replays it.

## Testing

Each provider is proved at the child invocation, not at a call boundary. `subagent-codex` asserts the `thread/start` frame the fake app-server actually receives, through `ctx.subagents.start` with a multi-root parent, and separately at the wire. `subagent-claude-code` reads `additionalDirectories` off the options the official `query` is called with. `subagent-acp` drives the real mock agent process, which echoes back the `additionalDirectories` it was handed under `MOCK_ECHO_ROOTS`; a third case pins the `cwd`-override behavior by asserting the parent's own workspace arrives as an additional root. `subagent-dsh-sdk` reads the `initialize` params the fake runtime recorded off the wire. The SDK server asserts the created session's log folds to the handshake roots, that an omitted list appends no event at all, and that a relative entry is refused with its path in the message. The SDK client asserts the resolved-absolute handshake payload and the empty-list omission.

The two confirmation guards are proved the same way. The ACP suite drives the real mock agent through all three protocol-legal answers — capability omitted, explicit `null`, and no `agentCapabilities` at all — and each refuses the multi-root start while the single-root case still runs against an unadvertised agent; disabling the gate makes every one of them resolve instead of reject, and reading `null` as support fails the null case alone. The Codex suite answers `thread/start` with the policy the real app-server returns, and refuses an ignored override, a `workspaceWrite` policy carrying no writable-root list, and an unreadable policy, while accepting `dangerFullAccess`; removing the check fails all three refusals, and skipping the `workspaceWrite` verification fails the two that matter.

Reverting each forwarding line fails its own test with the missing field named: `expected undefined to deeply equal [ '/second-root', '/third-root' ]` for Claude Code, the absent `config` key for Codex, `expected null to deeply equal [...]` from the ACP child's echo, the absent `additionalDirectories` for the SDK handshake, and `expected [] to deeply equal [...]` for the server's recorded roots.

The fake parent Agents in the four provider suites and the fake Agents in the SDK server suite gained the `session` members the resolve and record steps read; they were incomplete stubs of a type whose real values always carry them.

## Alternatives considered

**Forward the parent's complete root list (`sessionWorkspaceRoots`), so a `cwd`-overridden child keeps the parent's own workspace as an additional root.** Rejected after it was first built this way. It widens a child the deployment deliberately pinned elsewhere, handing it write access to a directory its configuration never named, and it turned every single-root `cwd`-override deployment into a multi-root delegation — which then failed the ACP negotiation gate. `effectiveWorkspaceRoots` is both the narrower answer and the one the in-process capture already uses, so the two delegation paths cannot disagree.

**Send the roots and let the child sort it out.** Rejected for ACP and Codex: an agent that ignores the field leaves the parent believing it granted a workspace the child never had, which is the silent narrowing this work removes. Refusing costs a delegation that would otherwise have run degraded; accepting costs correctness with no signal.

**Send Codex a structured `sandboxPolicy` on `turn/start`.** Rejected: `SandboxPolicy.workspaceWrite` is a complete record, so supplying it means this provider choosing `networkAccess`, `excludeTmpdirEnvVar`, and `excludeSlashTmp` values that the deployment's own Codex configuration already owns — hardcoded tunables in a plugin, to change one field the config override reaches directly.

**Send an empty root list unconditionally, for uniformity.** Rejected on Codex: the config map is an override, so an empty `writable_roots` would erase a deployment's configured roots. Uniform omission is applied to all four instead of splitting the rule per product.

**Carry the roots on the SDK wire inside `session/prompt` rather than `initialize`.** Rejected: `cwd` is a process-wide handshake fact recorded on every SDK-created session, and the roots are the same fact about the same workspace. A per-prompt field would let two sessions in one runtime disagree about a workspace the client described once.

**Add a `workspaceRoots` config field to each provider.** Rejected: the roots are a property of the delegating session, not a deployment choice, and a configured list would let a provider row contradict the parent's own log. The `cwd` override exists because a deployment may legitimately pin where a child runs; nothing analogous justifies a second, disagreeing root set.

## Consequences

A foreign child now reaches every folder its parent works in, so multi-root delegation behaves the same whether the child is in-process or a Claude Code, Codex, ACP, or nested-runtime process. The cost is four product-specific couplings, and two of them now also carry a check. A Codex version that renames the dotted config path fails the acknowledgement check loudly instead of narrowing silently, which is the better failure but still a failure: that deployment stops delegating until the key is updated. An ACP agent that has not adopted `SessionCapabilities.additionalDirectories` cannot take a multi-root delegation at all, though it still serves every single-root one. The exact-payload tests pin the current key, and the package's existing version-pinned-protocol limitation already requires re-running the protocol evidence on upgrade.

`InitializeParams` gained an optional field. Existing clients that omit it are unaffected — the server records nothing — so the Python SDK needs no change to keep working, and gains the capability only when it chooses to send the field.
