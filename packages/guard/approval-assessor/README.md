---
description: "Mandatory approval-stage audit that rejects missing or work-avoidance justifications and redirects the model to the user's instructions."
kind: "package-reference"
---

# @deepseek-ai/dsh-approval-assessor

English | [中文](README.zh.md)

## Summary

Every tool-approval request receives a mandatory audit. A missing justification or a justification that asks to skip, defer, or soften user-authorized work is rejected before an answerer can decide it. The rejection appends a short redirect that quotes the most recent human instruction. A non-evasive, non-empty justification reaches the normal approval flow only after that audit.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## Use this package

Every `dsh-base` profile mounts this plugin ahead of the product approval answerers. It has no deployment setting, stored setting, override, or opt-out. Each request must carry a non-empty justification that passes the audit before a downstream answerer can decide it.

### What you get

A request with a missing or work-avoidance justification is rejected, and the model receives a plugin-attributed message quoting the user's last instruction. Only a human message qualifies as that instruction: the user-role log also carries plugin snapshots such as the runtime-context notice, and quoting one of those would point the model at plugin text. `bash`, `pwsh`, `write`, and `edit` use the same mandatory audit as every other tool.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

The plugin listens on the `approval/request` waterfall before user-facing answerers; `dsh-base` mounts it before layers that add those answerers. It rejects a missing reason or a reason that matches a built-in work-avoidance pattern, injects a redirect with source `plugin: approval-assessor`, and resolves `rejected` without calling `next()`. A non-evasive justification delegates after the audit. The redirect reaches the log through the agent inbox as a later `user/message`. The `./invariant` companion ensures committed redirects never outnumber rejected approval decisions.

The audit applies to every approval request. Missing justification and built-in work-avoidance patterns reject. A session with no human message still receives the rejection without an instruction quote.

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

These limits define when the audit is a poor fit. They are current package constraints, not a task backlog.

- **Built-in work-avoidance patterns only** — detection is a fixed pattern list; a paraphrased evasion the list does not contain passes the audit. Learned or model-assisted detection is rejected pending evidence of need.
- **English patterns** — the built-in list matches English phrasing; work-avoidance justifications written in other languages reach the normal approval flow.
- **No configuration surface** — the pattern list is not settable from `cordis.yml` or stored settings; deployment-specific patterns require a plugin change.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
