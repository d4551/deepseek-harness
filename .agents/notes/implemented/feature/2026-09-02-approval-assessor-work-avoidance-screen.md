# Agent Note: Work-avoidance screening at the approval gate

Status: implemented

English | [中文](2026-09-02-approval-assessor-work-avoidance-screen.zh.md)

## Problem

An autonomous session can abandon requested work at the approval gate without any tool refusing it: the model asks for permission and puts the abandonment in the reason — "should I skip this since it's pre-existing?", "this is a known limitation, leave it" — and an operator reading only the tool name sees an ordinary approval question. Nothing in the approval waterfall examined the reason text, so a rationale that talked the channel out of the user's instruction passed through the same path as an honest one.

## Decision

`packages/guard/approval-assessor` (`@deepseek-ai/dsh-approval-assessor`) listens on the `approval/request` waterfall ahead of user-facing answerers and screens every request's reason against work-avoidance patterns — the vocabulary of ownership denial, temporal displacement, scope appeal, and effort decline. A match resolves `rejected` without calling `next()`, and the plugin appends one `user/message` (source `plugin: approval-assessor`) quoting the session's latest user instruction, so the model meets the original task next to the denial and returns to it. Non-matching reasons delegate unchanged. The plugin registers user-owned Host settings seeded from its composition values: `enabled: false` delegates everything, and `extraPhrases` adds up to 64 case-insensitive literal phrases of at most 256 characters each. Empty phrases or values beyond those bounds reject the settings update before persistence, regular-expression syntax has no special meaning, and provider-published changes apply to later requests.

The `./invariant` companion owns one runtime relation: every `user/message` this plugin injects must be appended while an approval question is still open in the same session (between its `approval/asked` and `approval/decided`), because the injection exists only as rejection context for that question.

## Alternatives considered

**Block via the interaction permission layer instead of a waterfall listener.** Rejected: permission answers who may run a tool, not why it was asked; the failure mode lives in the reason text, and screening it belongs at the approval request the reason rides on.

**Exclude tools with their own safety policy.** Rejected: the assessor judges whether the reason abandons user-authorized work, not whether the requested operation is safe. Screening neither grants permission nor replaces a tool's safety policy, so every tool follows both decisions.

**Inject the redirect as a system-prompt addition rather than a session event.** Rejected: model-visible inputs must be reconstructable from the session log, and a one-time rejection context is wrong as a persistent prompt fact.

**Expose arbitrary regular expressions through a linear-time engine.** Rejected: the additional policy needs literal vocabulary, not a second regular-expression language. A native RE2 binding would add platform-specific installation obligations, while the available WebAssembly binding does not provide the maintenance assurance required here. Bounded literal phrases remove executable pattern syntax and keep the package dependency-free.

## Consequences

A model cannot steer the approval channel into abandoning the user's instruction by phrasing: the rationale itself is the trigger, and the denial carries the instruction back. The cost is static rule and bounded literal-phrase matching, not intent analysis — a paraphrase that matches no rule delegates, and users who need broader or non-English vocabulary configure `extraPhrases`. Configured phrases cannot express regular-expression operators such as word boundaries. The redirect adds one short message per rejection, appended after the denied request, so prior conversation cache is unaffected. Twenty-one behavior tests pin passthrough, rejection, literal matching, bounds, stored-policy reload, injection shape, and the disabled path.
