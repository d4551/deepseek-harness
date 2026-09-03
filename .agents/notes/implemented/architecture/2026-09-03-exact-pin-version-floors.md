# Agent Note: Exact version pins had no floor, so four of them rotted unnoticed

Status: implemented

English | [中文](2026-09-03-exact-pin-version-floors.zh.md)

## Problem

`scripts/live-stack-floors.ts` held the root manifest to a floor per dependency, complete by construction: `unflooredRootDependencies` fails when the manifest declares something the floor map does not, so adding a dependency forces stating the version it may never fall below. Workspace manifests had no equivalent. Whatever a package pinned stayed pinned.

Four had gone stale, and the three worst are third-party *products* the harness drives as subprocesses, whose wire behavior changes between releases and whose test fixtures are hand-written mocks of that behavior:

| package | pinned | shipping |
| --- | --- | --- |
| `@openai/codex` | 0.149.1 | 0.153.0 |
| `@anthropic-ai/claude-agent-sdk` | 0.3.241 | 0.3.259 |
| `@anthropic-ai/sdk` | 0.93.0 | 0.123.0 |
| `e2b` | 2.29.1 | 2.46.1 |

`@anthropic-ai/sdk` was thirty minor versions behind. Nothing in the repository could report that, because nothing looked.

## Decision

The gate now governs exact pins across the workspace. An exact pin is the specific range that cannot drift upward on its own — a caret range tracks minors, while `"0.149.1"` stays on 0.149.1 until a person changes it — so exact pins are where a stack silently rots and are the only ranges this check claims.

`PINNED_PRODUCT_FLOORS` states the floor for each, and `PIN_FLOORS` composes it with `ROOT_DEPENDENCY_FLOORS` so a workspace manifest pinning a member of a root family is held to the same number rather than repeating it. `unflooredPinnedDependencies` keeps the map complete the way the root map already was: pin something new and the gate demands its floor.

`website/` is excluded. It is a VitePress projection whose dependency set is VitePress's own, including the Vite 5 that VitePress pins, which the repository's Vite 8 floor would otherwise reject. The existing spec already carried that exception for Vite; the exclusion states it once instead of per-package.

## Alternatives considered

**Govern every range, not just exact pins.** A caret range already tracks upstream within its major, so a floor on one restates what the range says until a major arrives — noise on every dependency to catch the few that a major has left behind. The exact pins are where the evidence of rot actually was.

**Convert the product pins to caret ranges.** It would let them drift on their own, and drift is exactly wrong here: each of these products is mocked by a hand-written fixture of its wire protocol, so a version moving underneath the fixture is how `subagent-codex` came to fail. Pinning is right; pinning without a floor is not.

**Read the shipping version from the registry at gate time.** The gate would then need network access, would fail differently on a bad day than on a good one, and would turn every upstream release into a red build. A stated floor is a reviewed decision with a date attached.

## Consequences

The floor gate fails on the four stale pins, naming each with its declared range. A new exact pin cannot be added without stating the version it may never fall below, and `website/`'s VitePress-owned stack is exempt in one place with its reason.
