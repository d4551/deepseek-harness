# Agent Note: Work-avoidance screening at the approval gate

Status: implemented

English | [中文](2026-09-02-approval-assessor-work-avoidance-screen.zh.md)

## Problem

An autonomous session can abandon requested work at the approval gate without any tool refusing it: the model asks for permission and puts the abandonment in the reason — "should I skip this since it's pre-existing?", "this is a known limitation, leave it" — and an operator reading only the tool name sees an ordinary approval question. Nothing in the approval waterfall examined the reason text, so a rationale that talked the channel out of the user's instruction passed through the same path as an honest one.

## Decision

`packages/guard/approval-assessor` (`@deepseek-ai/dsh-approval-assessor`) listens on the `approval/request` waterfall ahead of user-facing answerers and screens each request's reason against work-avoidance patterns — the vocabulary of ownership denial, temporal displacement, scope appeal, and effort decline. A match resolves `rejected` without calling `next()`, and the plugin appends one `user/message` (source `plugin: approval-assessor`) quoting the session's latest user instruction, so the model meets the original task next to the denial and returns to it. Requests whose tool is `bash`, `write`, or `edit` pass through unconditionally: those tools' approvals are governed by their own safety policy, and reason-text screening must not become a second gate in front of them. Non-matching reasons delegate unchanged. `enabled: false` delegates everything; `extraPatterns` adds session-specific regex sources compiled at load, and an invalid pattern fails load loudly.

The `./invariant` companion owns one runtime relation: every `user/message` this plugin injects must be appended while an approval question is still open in the same session (between its `approval/asked` and `approval/decided`), because the injection exists only as rejection context for that question.

Superseded 2026-09-03. This paragraph recorded that the canonical README limitations heading (`## Known Limitations and Deferred Work`) could not be written, so the package was whitelisted in `scripts/verify-package-readme-limitations.ts` and documented its boundaries under `## Behavior Boundaries` instead. The claim did not hold: the heading writes without interference, and it was a property asserted about an authoring tool rather than about this package. The whitelist entry is deleted, the section carries the canonical heading, and the same reason had been copied into two other packages' entries, which are deleted too.

## Alternatives considered

**Block via the interaction permission layer instead of a waterfall listener.** Rejected: permission answers who may run a tool, not why it was asked; the failure mode lives in the reason text, and screening it belongs at the approval request the reason rides on.

**Intercept every tool regardless of safety class.** Rejected: `bash`, `write`, and `edit` carry their own approval policy where reason text is not the deciding input; a pattern match in front of them could deny a request their policy would allow, doubling the policy surface.

**Inject the redirect as a system-prompt addition rather than a session event.** Rejected: model-visible inputs must be reconstructable from the session log, and a one-time rejection context is wrong as a persistent prompt fact.

## Consequences

A model can no longer steer the approval channel into abandoning the user's instruction by phrasing: the rationale itself is the trigger, and the denial carries the instruction back. The cost is reason-text matching, not intent analysis — a paraphrase that matches no pattern delegates, and sessions that need broader vocabulary must configure `extraPatterns`. The redirect adds one short message per rejection, appended after the denied request, so prior conversation cache is unaffected. The package carries the canonical limitations heading as its final section, after `## Model Experience`, with no verifier allowlist entry. Sixteen behavior tests pin passthrough, rejection, injection shape, config validation, and the disabled path.
