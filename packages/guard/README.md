---
description: "Package map for the loop-hygiene guard family: the advisory repeat-tool reminder, the per-call tool-call timeout policy, and the approval-reason work-avoidance screen, for users and maintainers choosing or composing the guards."
kind: "package-group"
---

# guard/ — loop-hygiene guard family

English | [中文](README.zh.md)

## Summary

The `guard/` group keeps the agent loop productive by watching for three common failure patterns. `repeat-tool-reminder` notices when the model repeats the exact same tool call and reminds it to change approach or finish, so a stuck loop stops burning time and tokens. `timeout-policy` puts a time limit on tool calls that declare one, so a hung call returns a clear timed-out error to the model instead of stalling the session. `approval-assessor` screens the reason text of approval requests and rejects the ones that argue for abandoning instructed work, quoting the user's last instruction back to the model. All three ship enabled in the `dsh` base bundle; a composition can tune or remove them, and `approval-assessor` also answers to the Plugins settings page.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

Three small plugins cover the three patterns; each README below explains when to keep, tune, or remove it.

| Package | What it provides |
|---|---|
| [`repeat-tool-reminder/`](repeat-tool-reminder/README.md) | Reminds the model when it repeats the same tool call, so it changes approach or finishes |
| [`timeout-policy/`](timeout-policy/README.md) | Times out tool calls that declare a limit, so the model gets a clear error instead of waiting forever |
| [`approval-assessor/`](approval-assessor/README.md) | Rejects approval requests whose reason argues for skipping instructed work, and redirects the model to that instruction |

-----

<a id="related-documentation"></a>
## Related documentation

Start with the tools subsystem reference for the tool-call pipeline, then the reminder's configuration, the timeout-library decision behind the policy, and the mounting decision that puts the approval screen in every base-backed profile.

- [Tools subsystem reference](../../docs/subsystems/tools.md) — the tool-call pipeline and decisions these guards build on.
- [Generated configuration catalog](../../docs/config-catalog.md#deepseek-aidsh-repeat-tool-reminder) — every accepted field of the repeat-call reminder.
- [Timeout deadline library Agent Note](../../.agents/notes/implemented/architecture/2026-07-06-timeout-deadline-library.md) — the timing/termination split `timeout-policy` enforces.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
