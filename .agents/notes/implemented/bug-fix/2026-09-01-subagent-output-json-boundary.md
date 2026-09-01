# Agent Note: The subagent tool asserted its output was JSON instead of checking

Status: implemented

English | [中文](2026-09-01-subagent-output-json-boundary.zh.md)

## Problem

The `subagent` tool declares its foreground output as `{ type: 'array', items: { type: 'json' } }`, and `settleForegroundRun` filled it by writing `result.output as unknown as JsonValue[]`. A run produces `readonly ContentBlock[]`, and `ContentBlock` derives from the merge-extensible `ContentBlockMap`, so a plugin can contribute a block that no static type promises is serializable. The double assertion laundered that possibility away: nothing checked, and the declared item type claimed a guarantee the type system cannot make. The comment beside it pointed at the tool registry as the real boundary, which is true — `snapshotToolValue` raises `ToolOutputError` on a value that is not lossless JSON — but a cast is not how a caller relies on a downstream check.

## Decision

`isJsonBlocks` is a type predicate over `isJsonValue`, so the blocks narrow to `JsonValue[]` from a runtime walk rather than an assertion, and no `as` remains on the path. Output that fails the walk throws with the run id, one layer above the registry's own invalid-output failure, so the diagnostic names which subagent produced the block instead of only which tool returned it. Every core block type — text, reasoning, image, tool-call, tool-result — is plain JSON, so no shipped block reaches the new throw; a value that does would have failed the registry's snapshot immediately afterwards, which is why this is a clearer failure rather than a new one.

The scripted provider fixture contributes a `scripted-unserializable` block through the same `ContentBlockMap` merge a plugin would use, so the check is exercised by a genuinely typed block rather than by a cast that manufactures one.

## Alternatives considered

**Declare the carrier as `readonly ContentBlock[]` and let the registry decide.** The tool's own declared output schema is an array of JSON items, so the compiler rejects the wider type at the tool definition — the schema, not the carrier, is what fixes it.

**Snapshot with `snapshotJsonValue` here.** It detaches as well as validates, which duplicates the copy the registry makes immediately afterwards on every foreground result. `isJsonValue` walks the same boundary without the copy.

**Leave the assertion and rely on the registry.** That is what the previous comment argued. It works until a plugin block reaches a reader that trusts the declared `JsonValue[]` — `outputValueText` already re-checks every field structurally rather than trusting it, which is the same doubt written twice.

## Consequences

A plugin block that is not lossless JSON now fails with a message naming the run rather than a generic invalid-output error. `ContentBlockMap` gains a test-only entry inside the tool-subagent test program; the block exists to be rejected and no production path constructs it.
