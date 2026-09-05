---
description: "Package map for the loop-hygiene guard family: the advisory repeat-tool reminder, the per-call tool-call timeout policy, the approval-reason work-avoidance screen, and the opt-in adversarial approval reviewer, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive by watching for common failure patterns at the tool call and the approval gate. `repeat-tool-reminder` notices when the model repeats the exact same tool call and reminds it to change approach or finish, so a stuck loop stops burning time and tokens. `timeout-policy` puts a time limit on tool calls that declare one, so a hung call returns a clear timed-out error to the model instead of stalling the session. `approval-assessor` screens the reason text of approval requests and rejects the ones that argue for abandoning instructed work, quoting the user's last instruction back to the model. `approval-adversary` goes one step further when a user turns it on: a model reviewer decides each remaining approval request in place of a human prompt, assuming the agent is avoiding or overreaching the instruction. The first three ship enabled in the `dsh` base bundle and the reviewer ships mounted but off; a composition can tune or remove them, and both approval guards answer to the Plugins settings page.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Four small plugins cover the patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`approval-assessor/`](approval-assessor/README.md) | Rejects approval requests whose reason argues for skipping instructed work, and redirects the model to that instruction |
| [`approval-adversary/`](approval-adversary/README.md) | Decides approval requests with an adversarial model review in place of a human prompt, once a user enables it |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration, the timeout-library decision behind the policy, the approval subsystem reference the two approval guards answer into, and the decision behind the adversarial reviewer.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions these guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.
- [User approval subsystem reference](../../docs/subsystems/approval.md) — the answerer waterfall and audit pair both approval guards work inside.
- [Adversarial approval reviewer Agent Note](../../.agents/notes/implemented/feature/2026-09-05-approval-adversary-model-reviewer.md) — why a model reviewer replaces the human prompt only as an opt-in, and what it gives up.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
