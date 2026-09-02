---
description: "Approval-stage guard that detects work-avoidance justification in tool-approval requests and rejects them with a redirect to the user's instructions, for users and maintainers choosing, configuring, or debugging the plugin."
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-assessor

English | [中文](README.zh.md)

## Summary

When a model asks for tool approval, the reason it gives can itself be the failure: "should I skip this since it's pre-existing?", "this is a known limitation", "leave it as-is" — rationales that talk the approval channel into abandoning work the user asked for. `dsh-approval-assessor` screens the reason text of every approval request against work-avoidance patterns and rejects matches instead of forwarding them, injecting a short redirect into the session that quotes the user's last instruction so the model returns to the task. Non-matching requests pass through untouched to the normal approval flow, and safety-critical tools (shell, write, edit) always pass through so their own policy checks decide. Patterns ship a default set and accept extras from configuration.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin when autonomous sessions must not talk themselves out of requested work at the approval gate. There is nothing to wire: every approval request with a reason passes through the assessor, matches reject, everything else delegates.

### Configuring patterns and the toggle

```yaml
- name: '@deepseek-ai/dsh-approval-assessor'
  config:
    enabled: true            # false disables all interception; every request delegates
    extraPatterns:           # additional case-insensitive regex sources, compiled at load
      - 'should i bother'
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `false` makes the assessor delegate every request |
| `extraPatterns` | `[]` | Extra regex sources matched against the approval reason |

Invalid `extraPatterns` (non-regex, empty) fail at plugin load with a clear error, never a silent skip.

### What you get

A request whose reason matches a work-avoidance pattern is rejected, and the model receives a plugin-attributed message quoting the user's last instruction — the model sees the original task next to the rejection and returns to it. Requests for `bash`, `write`, and `edit` are never intercepted by pattern: their approval is governed by their own safety policy, not by reason text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin listens on the `approval/request` waterfall before user-facing answerers. On each request it checks the tool against the safety-gate list (passthrough), then the reason against the built-in and configured patterns. On a match it appends a `user/message` (source `plugin: approval-assessor`) quoting the latest user instruction and resolves `rejected` without calling `next()`. On no match it delegates. The `./invariant` companion asserts every injected message lands while an approval question is still pending in the same session.

## Model Experience

### Rejection redirect message

#### What the model sees

When a work-avoidance pattern matches, the model receives the message below as a `user/message` attributed to `plugin: approval-assessor`, with the user's last instruction quoted after it. No tool schema or normal-call text changes.

##### Rejection redirect

```markdown
Approval denied: the request to approve "<toolName>" appears to be work-avoidance, not a legitimate safety gate. Do not ask for permission to skip, defer, or soften work the user already instructed you to do. Refer to the user's original instructions and proceed.

User instruction: <excerpt of the user's last instruction, capped at 500 chars>
```

#### Token effect

Zero tokens until a match. Each rejection adds one retained-history message whose data-dependent part is bounded by the 500-char instruction excerpt.

#### KV Cache effect

Append-only; the redirect follows the denied approval request in history and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

These bounds define when the guard is a poor fit. They are current package constraints, not a task backlog.

- **Reason-text matching only** — paraphrased avoidance that matches no pattern delegates; `extraPatterns` covers session-specific vocabulary at configuration time.
- **Safety-class passthrough** — `bash`, `write`, and `edit` requests are screened by their own approval policy, never by reason patterns.
- **Redirect quotes the last user instruction** — a session with no prior user message rejects without a quoted instruction.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and directions that are not decided. It is explicitly non-authoritative — shipped behavior, limits, and accepted rationale live in the sections above, the package code, and the linked Agent Notes.

The [approval-assessor feature note](../../../.agents/notes/implemented/feature/2026-09-02-approval-assessor-work-avoidance-screen.md) records the design and the safety-class passthrough rationale.

</details>
