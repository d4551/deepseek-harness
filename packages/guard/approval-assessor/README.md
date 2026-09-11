---
description: "Default approval screening that rejects missing or matching work-avoidance justifications and redirects the model to the user's instructions."
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-assessor

English | [中文](README.zh.md)

## Summary

Screen tool-approval requests before an answerer can decide them. Screening is enabled by default and rejects missing justifications or reasons that match rules for skipping, deferring, or softening user-authorized work. A rejection redirects the model to the most recent human instruction. A non-empty justification that passes screening continues to the configured answerer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Every `dsh-base` profile mounts this plugin ahead of the product approval answerers. Its composition values seed a user-owned Host settings section, so the policy can change without replacing the plugin row. Each enabled request must carry a non-empty justification that passes the audit before a downstream answerer can decide it.

### Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Reject missing and matching work-avoidance reasons; `false` delegates active requests unchanged. |
| `extraPhrases` | `[]` | Add up to 64 case-insensitive literal phrases of at most 256 characters each. Regular-expression syntax has no special meaning. |

The generated [configuration catalog](../../../docs/config-catalog.md#deepseek-aidsh-approval-assessor) is the exhaustive source for the composition fields. The Host settings section uses the same fields under the `approval-assessor` namespace and applies persisted or externally published changes to later requests.

### What you get

A request with a missing justification or a matching work-avoidance phrase is rejected, and the model receives a plugin-attributed message quoting the user's last instruction. Only a human message qualifies as that instruction. `bash`, `pwsh`, `write`, and `edit` use the same screening policy as every other tool.

A request withdrawn before screening resolves `cancelled` without a redirect or downstream decision, even when screening is disabled.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin listens on the `approval/request` waterfall before user-facing answerers; `dsh-base` mounts it before layers that add those answerers. It reads the current Host settings, rejects a missing reason or a reason that matches a built-in or configured work-avoidance pattern, injects a redirect with source `plugin: approval-assessor`, and resolves `rejected` without calling `next()`. A disabled policy or non-evasive justification delegates after the audit. The redirect reaches the log through the agent inbox as a later `user/message`. The `./invariant` companion ensures committed redirects never outnumber rejected approval decisions.

The enabled audit applies to every approval request. Missing justification and built-in or configured work-avoidance patterns reject. Matching normalizes Unicode to NFKC, removes default-ignorable code points, and folds whitespace and case for both reasons and configured phrases. A session with no human message still receives the rejection without an instruction quote.

<a id="model-experience"></a>
## Model Experience

### Rejection redirect message

#### What the model sees

When a work-avoidance pattern matches, the model receives the message below as a `user/message` attributed to `plugin: approval-assessor`, with the user's last instruction quoted after it. No tool schema or normal-call text changes.

##### Rejection redirect

```markdown
Mandatory approval audit denied "<toolName>": the justification is missing or indicates work-avoidance. Do not ask for permission to skip, defer, or soften work the user already instructed you to do. Refer to the user's original instructions and proceed.

User instruction: <excerpt of the user's last instruction, capped at 500 chars>
```

#### Token effect

Zero tokens until a rejection. Each rejection adds one retained-history message whose data-dependent part is bounded by the 500-char instruction excerpt.

#### KV Cache effect

Append-only; the redirect follows the denied approval request in history and does not invalidate existing KV-cache entries.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define when the audit is a poor fit. They are current package constraints, not a task backlog.

- **Rule matching only** — a paraphrased evasion that matches neither a built-in rule nor an `extraPhrases` entry passes screening. Enable the [adversarial reviewer](../approval-adversary/README.md) for model-based authorization review after this stage.
- **Built-in rules are English** — other languages require deployment-specific entries in `extraPhrases`.
- **One user-owned policy** — the Host settings namespace applies one enabled state and phrase list to every approval request; it does not select policy by tool or session.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
