# Agent Note: Snapshot lane repair after multi-root and rendered-fetch changes

Status: implemented

English | [中文](2026-09-03-snapshot-lane-repair.zh.md)

## Problem

Three changes landed without the recorded-session evidence [testing policy](../../../../docs/testing.md) requires, and `bun run test:snapshot` went red on four scenarios.

`packages/acp/acp/src/index.ts` gained multi-folder support: `session/new` and `session/resume` now validate `additionalDirectories` and record the accepted roots through `setAdditionalWorkspaceRoots`. The `snapshots/acp/reject-extra-dirs` scenario still asserted the removed refusal `Invalid params: additionalDirectories is not supported`, and the snapshot harness still described `additionalDirectories` and `mcpServers` as unimplemented — `mcpServers` had become a supported stdio and HTTP transport list in the same period.

`packages/context/agent-instructions/src/config.ts` added `additionalRoots` to `workspaceBaselineIdentity`. That string reaches the model through the baseline instructions message and is persisted with it, so `agent-instructions` and `ptc-workspace-context` diverged from their committed session logs.

The base bundle named `fetchProvider: playwright` for the shipped rendered route. `snapshots/session/web-fetch` had relied on being the only registered fetch provider, so its loopback fixture stopped being selected and the rendered route resolved `public.test` against real DNS, recording `getaddrinfo ENOTFOUND public.test` as the tool result. That is the repository's only session-level `web_fetch` coverage.

## Decision

**The ACP scenario asserts acceptance.** `snapshots/acp/reject-extra-dirs` is `snapshots/acp/additional-directories`. It initializes, sends one `session/new` whose `additionalDirectories` entry is relative and is refused with `additionalDirectories entries must be absolute paths`, then sends one whose entry is absolute and is accepted. The scenario sets `comparesLog: true` so the durable `workspace/roots` event carrying `{{cwd}}/extra-root` is the evidence that the accepted root took effect; a `session/new` result frame alone would only show that the call returned. A scenario-local `workspace/extra-root/` seed makes the declared root a directory the client actually has.

**Committed input scripts name the generated workspace with `{{cwd}}`.** `newSession` and `newSessionExpectError` both accept `additionalDirectories` and send each entry verbatim after substituting `{{cwd}}` with the run's generated root. One rule covers both steps, so a single script can name an absolute root the bridge accepts and a relative spelling it refuses, and the token matches the one the normalizers write back into expected output.

**The two baseline-identity fixtures carry the new field and nothing else.** Each `baselineIdentity` string gained `"additionalRoots":[]`. The change was measured against a keyless replay first and applied only after confirming that no other value differed.

**The web-fetch overlays name their route.** `snapshots/session/web-fetch/cordis.yml` and its replay sibling state `fetchProvider: http`, and disable `web-fetch-playwright` alongside the `web-fetch-http` row the fixture replaces. The fixture registers the real `HttpFetchProvider` under the seam's `http` id with an injected resolver, so naming that id is what selects it; leaving the rendered row mounted would also probe for a browser installation at mount and make the composition depend on the host. The scenario's recorded session log, prompt pin, and tool-schema pin are unchanged.

## Alternatives considered

**Delete the ACP scenario.** Rejected. Deleting the only protocol-level coverage of the workspace-scope decision to make the lane green removes evidence rather than updating it, against "tests describe behavior, not correctness".

**Keep the scenario as a rejection probe only.** Rejected. The multi-folder deliverable is acceptance; a case that only shows a relative path being refused would leave the shipped behavior unasserted at the protocol level.

**Cover the remaining refusal with an invalid `mcpServers` entry instead of a relative root.** Rejected for this scenario. A relative `additionalDirectories` entry is the direct sibling of the accepted spelling and fails in the same validation step, so both outcomes read from one script.

**Resolve every declared root against the run cwd.** Rejected. The relative-spelling refusal could then not be expressed at all, and `newSession` and `newSessionExpectError` would carry different meanings for the same field.

**Re-record the two headless scenarios with `test:snapshot:refresh`.** Rejected as committed output. Refresh additionally recanonicalized `sourceEventSeqs` from flat lists into the range form `encodeSeqRanges` now writes. That rewrite is semantically neutral — `normalizeSessionLog` decodes both sides before comparing — but it is a separate, corpus-wide storage migration and does not belong in this change.

**Register the fixture provider under the `playwright` id.** Rejected. The scenario would claim rendered-route coverage while running the address-pinned HTTP transport.

**Drive the rendered route against a local server.** Rejected. It needs a Chromium installation the keyless lane cannot assume, and the rendered route's destination policy admits only public unicast addresses, which loopback is not.

## Testing

`bun run test:snapshot` covers all four scenarios. The ACP case was proved to guard: removing the `setAdditionalWorkspaceRoots` call from `session/new` fails it with the missing `workspace/roots` event named in the diff.

`packages/test-support/session-snapshot/tests/harness.spec.ts` asserts the `{{cwd}}` substitution reaches the wire, using a fake agent whose refusal quotes the roots it received.

## Consequences

The ACP corpus now asserts multi-folder acceptance through its durable record instead of a removed refusal, and one input script can exercise both admitted and refused workspace scopes.

The shipped rendered fetch route has no session-level snapshot. `snapshots/session/web-fetch` pins the address-pinned HTTP route, which is a supported deployment choice and the only one a keyless, browser-free lane can drive deterministically. Rendered-route evidence stays with `packages/web/web-fetch-playwright` until a lane that owns a browser can host it.

Committed session fixtures still store `sourceEventSeqs` in the pre-range form. The next `test:snapshot:refresh` of any scenario will rewrite that scenario's encoding; the comparison is unaffected either way.
