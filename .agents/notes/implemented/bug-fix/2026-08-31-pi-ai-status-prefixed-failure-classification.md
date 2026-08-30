# Agent Note: Classify pi-ai failures on the leading HTTP status

Status: implemented

English | [中文](2026-08-31-pi-ai-status-prefixed-failure-classification.zh.md)

## Problem

pi-ai flattens a provider failure to one string, so `dsh-llm-pi-ai` recovers a stable code by scanning that text. The scan ran `/\b(?:401|403)\b/` over the whole string first, and the string is a status followed by the provider's entire response body. A gateway that answers `502` with an HTML waiting page embeds its logo as an inline SVG, and those path coordinates contain `403` (`... 121.52 403.66 117.89 ...`), so the page classified as `AUTH`. `AUTH` is outside the default retryable set, so a transient upstream outage ended the turn immediately and reported an authentication failure the operator could not act on: the key was fine.

## Decision

A failure whose text opens with the provider's HTTP status — bare (`502 <body>`) or labeled (`HTTP 401: …`) — is classified from that status alone. `401` and `403` are `AUTH`; `5xx` is `SERVER` without reading the body at all; a rate-limit refusal is the one status that still consults the body, because `429` carries either quota exhaustion or ordinary throttling; `400` and `413` are `INVALID_REQUEST`; any other status is `PI_AI_ERROR`. Text without a leading status keeps the existing word rules, which are the only signal for transport truncation, socket drops, and timeouts — none of which arrive with a status.

Context-window overflow is unaffected: `mapStopReason` recognizes it from pi-ai's usage and from the message before classification runs.

## Alternatives considered

**Reorder the text rules so `5xx` wins over `401|403`.** Rejected because it fixes only the observed page. Any body digit can still read as a status: the same HTML matches `\b400\b` and `\b413\b` in CSS lengths, so a 502 would become `INVALID_REQUEST` instead.

**Strip HTML before scanning.** Rejected because the body is not always HTML — JSON payloads carry ids and token counts that scan the same way — and it adds a parser to a path that already knows the status.

**Match the status only at the string start without the `HTTP` label form.** Rejected because pi-ai providers emit both spellings, and the labeled form is what the existing tests pin.

**Treat every unrecognized status as `SERVER` so it retries.** Rejected because retrying a `404` model name or a `402` billing refusal repeats a request that cannot succeed; `PI_AI_ERROR` keeps them terminal.

## Consequences

A gateway or upstream 5xx now retries under the default policy and reports as a server failure, so a waiting-for-upstream page no longer reads as a rejected credential. Codes derived from a leading status no longer depend on body content, which removes a whole class of accidental matches. A provider that reports a status only inside its JSON body, with no leading status, still reaches the word rules and classifies as before.
