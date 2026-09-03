# Agent Note: One shell tool package per role, with the shell as config

Status: implemented

English | [中文](2026-09-03-one-shell-tool-per-role.zh.md)

## Problem

Four packages published two model-facing shell tools twice: `dsh-tool-bash`/`dsh-tool-pwsh` over the `ctx.shell` seam, and `dsh-tool-bash-persistent`/`dsh-tool-pwsh-persistent` over the `ctx.terminals` seam. Each pwsh package carried a comment declaring itself a deliberate mirror of its bash twin, and the clone gate — once the `jscpd:ignore` markers those comments doubled as were removed tree-wide — reported 20 clones across the two pairs: 7 in the one-shot pair and 13, about 316 lines, in the persistent pair.

The [parallel-surfaces note](../simplification/2026-09-03-bash-pwsh-parallel-surfaces.md) had already moved everything the *provider* layer shared into `@deepseek-ai/dsh-shell`, and it escalated these 20 rather than continuing: hoisting Consumer code into the seam would force `@deepseek-ai/dsh-shell` — and therefore every executor provider depending on it — to require `dsh-tools`, `dsh-jobs`, `dsh-agent`, `dsh-terminal`, and `dsh-user-approval`. That escalation recorded the decisive fact: after the provider extraction, the pwsh twins carried no behavior their bash counterparts did not.

## Decision

Each pair collapses into one dialect-parameterized package. `@deepseek-ai/dsh-tool-bash` and `@deepseek-ai/dsh-tool-pwsh` become `@deepseek-ai/dsh-tool-shell`; `@deepseek-ai/dsh-tool-bash-persistent` and `@deepseek-ai/dsh-tool-pwsh-persistent` become `@deepseek-ai/dsh-tool-shell-persistent`. Both names state the role that exists — a model-facing shell tool — rather than the first shell either implemented, per the [naming rule](../../../../docs/cookbook/adding-a-package.md#name-the-role-that-exists).

The shell is a validated `Config` field, `dialect: 'bash' | 'pwsh'`, declared with `.required()` and therefore carrying **no default**. A default would let a composition that mounts a PowerShell executor and forgets the field silently advertise a `bash` tool over a shell that cannot parse bash — exactly the silent misconfiguration `Misconfiguration fails loud` forbids. Stating it costs one line beside the executor row that already had to choose.

### What the dialect selects

The one-shot tool's [`src/dialect.ts`](../../../../packages/shell/tool-shell/src/dialect.ts) holds a `Record<ShellDialectName, ShellToolDialect>`; every field in it is a model-visible string or the identifier of one:

| Field | `bash` | `pwsh` |
|---|---|---|
| `toolName` | `bash` | `pwsh` |
| `jobKind` | `bash` (from `dsh-jobs`) | `pwsh` (declaration-merged here) |
| `sectionName` / `sectionOrder` | `tool:bash` / 1000 | `tool:pwsh` / 1010 |
| `sectionText` | the exit-marker reminder | the exit-marker reminder plus the Windows exit-1 reading |
| `intro` | `` Execute a bash command (`bash -c`) … `` | `` Execute a PowerShell command (`pwsh -Command`) … `` |
| `freshProcess` | fresh shell, pass `workdir` | fresh pwsh process, plus native `C:\…` paths and `$env:NAME` |
| `managedEnv` | `` `$DSH_*` `` | `` `$env:DSH_*` `` |
| `platformNote` | empty | the force-killed-settles-as-exit-1 sentence |
| `escalationPrefix` | empty | the ConstrainedLanguage and named-pipe paragraphs |
| `commandDescription` / `descriptionExample` | bash wording | PowerShell wording |

Everything else the tool publishes — the exit-marker sentence, the sandbox-denial sentence, the truncation sentence, the background sentences, the parameter set, the output schema, presentation, workdir resolution, escalation approval, request assembly — has one definition. The `DSH_*` prefix in both `managedEnv` strings now interpolates `DSH_ENV_PREFIX` from the seam instead of being spelled twice.

The persistent tool's [`src/dialect.ts`](../../../../packages/shell/tool-shell-persistent/src/dialect.ts) holds the PTY driving rules, which are the genuine platform differences:

- **Command wrapping and quoting.** bash emits `printf` markers around `eval -- $'…'` and reports `$?`; pwsh emits `Write-Output` markers around `Invoke-Expression "…"` with backtick escapes and resolves `$LASTEXITCODE` against `$?`. Both stay on one physical input line, for different reasons: bash would print PS2 for an embedded newline, pwsh would split the PSReadLine echo the extraction strips.
- **Setup and prompt.** bash submits `stty -echo` and keeps the backend's own prompt, so the backend's prompt-based readiness detection still works. pwsh has no echo switch, so it installs a private prompt (`__DSH_PERSISTENT_PWSH_PROMPT__ `) built from `[char]27`/`[char]7` at runtime, because raw ESC in submitted input is unreliable under PSReadLine. `prompt` is the single dialect field: its presence also enables the trailing-prompt strip in `trimTail` and the interior-prompt purge on the unanchored fallback path.
- **Settlement without a marker.** bash reads the backend's `stdin_read` wait reason; pwsh watches for its own prompt at the end of the viewport.
- **Marker infix and timeout code.** `__DSH_PERSISTENT_{BASH,PWSH}_{START,END}_<uuid>` and `PERSISTENT_{BASH,PWSH}_TIMEOUT` derive from one `markerInfix`.
- **Model-facing text.** Tool name, `command` parameter description, default description, the reset message, and the search command named in the clipped-output note (`` `grep -n` `` versus `Select-String`).

Wrapper stripping, which only pwsh used to need, is now unconditional in `commandOutput` and on the fallback path: the wrapper embeds the call's own UUID nonce, so any occurrence of it in captured text is that call's echoed input. For bash under `stty -echo` it is a no-op.

### Model-visible text is unchanged, with one exception

`gen-tool-catalog` boots each package twice, once per dialect, so the catalog documents both names under one section. Every `json` schema block in `docs/tool-catalog.md` is byte-identical to the pre-merge catalog: 65 blocks before, 65 after, identical as a multiset. Both prompt sections keep their names, orders, and text. The one recorded model-visible change is unrelated to the tools: the shipped `editing-cordis-compositions` skill names `tool-bash` as an example of a consumer row that must sit outside a realm, and that name had to become `tool-shell`. `snapshots/session/skill-load/session.jsonl` and `snapshots/web/skill-tool-row/ui.expected.md` were re-recorded for that one word.

### One behavior change: the pwsh workdir identity

`dsh-tool-pwsh` resolved a relative `workdir` against the raw session header cwd; `dsh-tool-bash` resolved it against the sandbox policy's canonical workspace root when one exists, and otherwise against `canonicalPath(headerCwd)`, so a confined command and its launch directory share one identity. The pwsh README recorded this as a known gap "deferred to the shared shell-tool base extraction". This is that extraction: the merged tool uses the bash resolution for both dialects, and the gap is closed. `canonicalPath` returns a missing path unchanged, so the existing pwsh workdir assertions over synthetic paths are unaffected.

### Composition

The base bundle's two platform-gated tool rows become one row that is never disabled and reads the same platform fact into its config:

```yaml
- id: tool-shell
  name: '@deepseek-ai/dsh-tool-shell'
  config:
    dialect: !!js "process.platform === 'win32' ? 'pwsh' : 'bash'"
```

The expression must be quoted. An unquoted `!!js a ? b : c` is not a plain YAML scalar — the parser reads `?` as an explicit-key indicator and ` : ` as the value separator, and the load fails with `object-based map does not support complex keys`. The base patch's `approval` row already used the quoted form for its ternary.

The `standard`, `ptc`, and `cordis` presets take the same one-row form. The persistent tool keeps two platform-gated rows in the `minimal` preset and the `sdk-minimal` bundle, because those rows differ in a way the dialect does not cover: each carries a different deployment-authored `description` that reaches the model.

## Alternatives considered

**Give `dialect` a `bash` default.** Rejected: every call site would still have to state `pwsh` where it matters, while a composition that mounts a pwsh executor and forgets the field would register a `bash` tool over PowerShell and fail only at the model's first command. The default buys four characters and costs a silent misconfiguration.

**Keep four packages and share the code through a fifth Consumer-layer package.** Rejected: a new package would need the same peer set as the tools (`dsh-tools`, `dsh-jobs`, `dsh-agent`, `dsh-user-approval`, and for the persistent pair `dsh-terminal`), so it would be the merged package with the tool registration removed — the merge without the benefit, and one more published name.

**Keep the pwsh persistent tool separate because its PTY handling genuinely differs.** Rejected on measurement: the differing part is 6 fields and 2 methods against roughly 316 duplicated lines of session registry, scrollback assembly, polling loop, capture rendering, and reset contract. The dialect record holds exactly the differences and nothing else.

**Keep two rows per composition, one per dialect, gated on platform as before.** Rejected for the one-shot tool: the tool name is the only thing the platform decides, and a config expression states that directly, while two mutually exclusive rows make a reader check that the gates are exact complements. Kept for the persistent rows, where the platform also decides a different model-facing `description`.

**Leave the pwsh workdir resolution as it was, to change no behavior.** Rejected: the difference was a recorded gap, not a platform fact, and preserving it would mean the merged tool carries a per-dialect branch whose only justification is that it used to exist.

**Keep the whole merged package out of the Windows lane, as `tool-bash` was.** Rejected: the win32 exclusion exists because the bash suites drive a real `bash -c`, which Windows has no interpreter for — while the pwsh suites are exactly what that lane exists to run. `scripts/vitest-inventory.ts` now excludes the two bash-dialect suite files by name instead of the package, and the package stays in the Windows coverage lane.

## Testing

Both suites of each pair moved into the merged package and now drive one implementation under one dialect: `tests/bash-dialect.spec.ts` and `tests/pwsh-dialect.spec.ts` in each package, plus `tests/bash-integration.spec.ts`, `tests/pwsh-integration.spec.ts`, and `tests/pwsh-loader.spec.ts` in `dsh-tool-shell` and the two loader-composition suites in `dsh-tool-shell-persistent`. No assertion was dropped: every case from all four packages survives, retargeted through the merged plugin with its dialect stated. Per-file coverage over the six merged source files is 100% on statements, branches, and functions.

`packages/bundle/base/tests/base.spec.ts` keeps its platform-gating case, now asserting that the two executor rows still carry complementary `!!js disabled` expressions, that the single `tool-shell` row is never gated, that its `dialect` expression evaluates to `pwsh` on win32 and `bash` on linux, and that no second row mounts the same package. `apps/cli/tests/windows-shell.spec.ts` makes the same assertions against the composed shipped bundle layers and the three presets.

## Consequences

Two published package names disappear and two appear; every manifest, tsconfig reference, composition, preset, snapshot composition, catalog, graph, and README moved with them, and the pre-release stance authorizes the rename without a compatibility shim. `dsh-agent-spine-demo`'s `toolBash` config field became `toolShell` and now forwards a `dialect`, defaulting to `bash` — the shell every composition that omitted the field has always mounted.

The clone gate over `packages/shell` reports zero clones. Repository-wide, 27 clones became 4, none of them in this family.

`gen-tool-catalog` mounts a package twice for the first time. That is sound because the schema depends on the dialect and on whether the mounted executor confines, never on which executor backs the seam, so one unconfined local executor satisfies both mounts. The per-package note states that a deployment mounts the package once.

`docs/capability-seams.md` and `apps/cli/composition.md` were edited by hand for the rename rather than regenerated: `bun run gen-doc-graphs` currently fails on an unrelated in-flight service (`missing service role classification: networkDrive`), so the generator could not run. Both files regenerate to the same content once that classification lands.
