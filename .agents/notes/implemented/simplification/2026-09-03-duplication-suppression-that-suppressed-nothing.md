# Agent Note: A duplication gate reporting zero over 562 in-file overrides

Status: implemented

English | [中文](2026-09-03-duplication-suppression-that-suppressed-nothing.zh.md)

## Problem

`bun run duplication` reported zero clones across 1,657 files while 562 `jscpd:ignore` markers stood in the source. 281 marked regions: 223 opened with a bare `/* jscpd:ignore-start */` and 58 with an inline reason after `--`.

A first reading of this got the mechanism wrong and is recorded here because the method was the error. `.jscpd.json` carries an `ignorePattern` regex matching only the bare delimiter, so the reasoned form does not match it — from which this note originally concluded that every marker carrying a reason suppressed nothing. That tested the config regex, not the tool. jscpd honours both forms through its own built-in marker handling, which the `ignorePattern` entry merely duplicates. Measured against jscpd itself on a two-file fixture: reasoned markers present, 0 clones; markers removed, 1 clone; bare markers, 0 clones. The suppression was real in both forms.

What the markers actually hid, measured by removing them and rerunning the gate: 45 clones behind the 223 bare markers, and about 90 more behind the 58 reasoned ones. A gate that reports zero while 135 clones stand behind in-file comments is measuring the comments, not the code.

## Decision

Two of the three groups are settled and the third is open work this note does not claim to have finished.

The 223 bare markers are gone. A marker that suppresses a finding without saying why is an override with no justification, and the 45 clones behind them were real: 25 inside three generated catalogs, 20 authored. The generated catalogs are named in `.jscpd.json`'s `ignore` list, where the exemption is one reviewable line per file rather than a delimiter pair buried in generator output, and `scripts/gen-client-catalog.ts` and `packages/typert/generator/src/cordis-catalog.ts` no longer emit markers into what they write. The 20 authored clones were fixed by extraction — shared hook-bridge and invariant-companion plumbing, the two `cordis-*-runner` planes, `bash-sandbox`/`pwsh-sandbox` helpers, and the two session-persistence providers.

The 58 reasoned markers are also gone, and their prose is kept as ordinary comments at the same sites. Their reasons were real — most name a deliberate bash/pwsh mirror recorded in an Agent Note — but a reason written beside a suppression is still a suppression the gate cannot see past, and one of these mirrors turned out to be 110 byte-identical lines that extracted cleanly into `@deepseek-ai/dsh-shell/sandbox-classify` once the marker stopped hiding it. The comment that had justified it was the excuse, not a platform difference.

Removing them leaves the gate red at roughly 90 clones, concentrated in `client/ui-chat`, `shell/tool-bash*`, `shell/bash-local`, `core/session`, and `credentials/credentials-local`. That is the honest state: the duplication was always there, and it is now visible instead of suppressed.

## Alternatives considered

**Keep the reasoned form and delete only the bare one.** It is the defensible half-measure: a documented exemption is not the same as an undocumented one. It was rejected because the standing instruction for this branch is that no justification makes an override acceptable, and because the one mirror examined closely was extractable, which suggests the reasons were not all load-bearing.

**Restore the markers to get the gate green again.** The gate reported zero for as long as they existed. Green obtained by re-hiding what was just measured is worth less than red that names the work.

**Fix the `ignorePattern` regex.** Irrelevant once jscpd's built-in handling is what suppresses; the config entry duplicates it and removing the entry alone changes nothing.

## Consequences

`bun run duplication` reports on the whole authored tree and exits non-zero on the remaining clones. Three generated catalogs are exempt by path.

Those three are `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` (written by `scripts/gen-client-catalog.ts`), `packages/extensions/cordis-client-runner/src/client/api-catalog.ts` (`scripts/gen-cordis-inspect-catalog.ts`), and `packages/extensions/tool-cordis/src/api-catalog.ts` (`scripts/gen-cordis-catalog.ts`). None of them is authored: each is rewritten from the type graph and compared byte-for-byte by its own `verify-*-catalog` gate, which fails as soon as the checked-in text drifts from what the generator produces. Their clones are the uniform one-record-per-Service, per-method, and per-type text the projector emits by construction, so the only way to delete a clone is to change what the generator writes, which edits model-visible catalog text to satisfy a gate whose subject is authored code. A path entry records that; `duplication` keeps full authority over every file a person edits.

The in-file escape is closed by a gate rather than by configuration, because jscpd's marker handling is built in and no setting turns it off: `scripts/no-duplication-overrides.ts` fails when any authored source carries a marker, including one a generator writes into its output, and `.jscpd.json`'s now-redundant `ignorePattern` entry is deleted. An exemption has to be a path in that config, where review sees it.

The measurement method is recorded above because checking a config's regex rather than the tool's behaviour produced a confident and wrong answer.
