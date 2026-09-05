# Agent Note: Adversarial model reviewer in place of the approval prompt

Status: implemented

English | [中文](2026-09-05-approval-adversary-model-reviewer.zh.md)

## Problem

The approval waterfall had two kinds of answerer: a person at a prompt, and deterministic rules. [`dsh-approval-assessor`](2026-09-02-approval-assessor-work-avoidance-screen.md) rejects reasons that match a work-avoidance vocabulary, and everything else reaches the human. An unattended session therefore either stalls at every approval or runs under the `never` policy that rejects all of them, and a paraphrased evasion that matches no rule passes the screen untouched. Nothing in the composition could judge a request the way the person would: against the user's instruction, the exact tool call, and the agent's stated reason.

## Decision

`packages/guard/approval-adversary` (`@deepseek-ai/dsh-approval-adversary`) listens on `approval/request` behind the assessor and ahead of every user-facing answerer. While enabled it decides each request with one auxiliary model call. The reviewer's fixed instruction tells it to assume the agent may be avoiding, narrowing, or overreaching the user's instruction, to deny missing, vague, evasive, destructive, out-of-scope, or check-weakening actions, and to allow only a direct, justified step; it answers with a two-line `VERDICT:` / `REASON:` protocol. The evidence is one JSON record: the latest human `user/message`, the `tool/call` the request's `callId` names with its raw arguments, and the asker's reason, each clipped to `maxExcerptChars`. The route is the configured `provider`/`model` pair or the agent's latest logged `request/header` route.

Every verdict becomes a `user/message` from `plugin: approval-adversary` with a `notice` form whose summary names the verdict: an allowed request tells the model the reviewer's reason, a denied request adds an instruction not to resubmit a reworded justification and quotes the user's instruction. The exact review request is appended as the log-only `approval/adversary-request` event before dispatch, so a model-visible auxiliary call is reconstructable from the session log. An undecided review, whether a timeout, a failed call, or a reply without a verdict line, follows `fallback`: `delegate` passes the request on to the next answerer, `reject` denies it with an unavailable notice. A question withdrawn during its review resolves `cancelled` with no notice.

The plugin registers a user-owned settings section seeded from its composition values, with a half-specified route refused at the write. `dsh-base` mounts it with `enabled: false`; the Web app's Plugins settings page renders an Adversarial approval review card over the served namespace, and turning the reviewer on is that card's job. Because the Host judges `provider` and `model` as a pair, the shared plugin-card form commits every staged section field in one settings mutation instead of one write per field, and reads each field back by JSON value; every card on that page saves that way. The `./invariant` companion holds one runtime relation: a session's allowed notices never outnumber its `allowed-once` decisions, and its denied plus unavailable notices never outnumber its `rejected` ones.

## Alternatives considered

**Ship the reviewer enabled.** Rejected: enabling it hands every approval a person would have answered to a model that assumes the worst of the agent. That is a deployment's decision about who holds the gate, so the base mounts the plugin armed but off and a user flips it from the settings card that the served namespace makes visible.

**Fold the review into the assessor.** Rejected: the assessor is a deterministic screen with no model call, no route, no timeout, and no undecided state; keeping it separate preserves a zero-cost first line and lets a deployment run either guard without the other.

**Answer without logging the review request.** Rejected: the review's system prompt and record reach a model, and model-visible input must be reconstructable from the session log. The pre-dispatch event follows the session-title precedent; the verdict itself needs no second event because `approval/decided` carries the outcome and the notice carries the reason.

**Notify the model only on denial.** Rejected: an allowed action that silently proceeds hides that a reviewer, not a person, granted it. One short line per grant makes the substitution visible in the transcript and in the Web conversation, and keeps the model aware that a reviewer reads its justifications.

**Fail closed on every undecided review.** Rejected as the only behavior: a deployment with a person available prefers the prompt to a denial when the reviewer is unreachable, while an unattended one prefers the denial. The choice varies by deployment, so it is a configured `fallback` rather than a fixed rule.

**Give the reviewer tools or the workspace.** Deferred: the reviewer judges only the record, which keeps one review to one bounded call. A reviewer that can inspect files is a different cost and trust decision.

## Consequences

An enabled deployment runs approvals without a person and without the `never` policy's blanket rejection, and a paraphrased evasion the assessor cannot match still meets a reader that judges intent against the instruction. The cost is one auxiliary model call per approval, one notice line per verdict in the agent's history, and a review that sees the record rather than the repository, so an action whose danger is only visible on disk can pass. The reviewer's verdict protocol is English and fixed; deployment instructions extend it and cannot replace it. The Web card takes the route as two text fields rather than the model directory. Package tests pin the opt-in default, the settings section, the logged request, the JSON record and its clipping, both fallbacks, cancellation, and every verdict notice; a real Loader composition drives an allowed and a denied escalation through the assessor and the reviewer and checks that the closing model request carries the notice; a browser scenario saves and clears the route pair through the card and sees the Host refuse half of one.
