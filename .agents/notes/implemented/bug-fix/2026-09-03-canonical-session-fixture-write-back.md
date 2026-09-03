# Agent Note: Snapshot write-back emits the canonical fixture layout

Status: implemented

English | [中文](2026-09-03-canonical-session-fixture-write-back.zh.md)

## Problem

A committed session fixture is a projection of the persisted JSONL log: it drops the encodings the storage layer owns and keeps the header and event payloads. Two storage encodings reached the fixture writer anyway.

`scrubSessionSnapshot` deleted the `seq`/`time` and `seq0`/`time0` envelopes but copied `sourceEventSeqs` through in the range form `encodeSeqRanges` produces at the JSONL storage boundary, so a refreshed `assistant/message` recorded `[[12,77]]` where the corpus records `[12…77]`. It also copied packed chunk rows exactly as the durable flush boundaries produced them, so a run split across two `eventLines` batches stayed two rows where the corpus records one.

The comparison path hid both. `normalizeSessionLog` decoded the provenance ranges and a separate repack step merged flush-split rows before comparing, so a fixture in either layout compared equal and `bun run test:snapshot` stayed green. Only `scripts/session-fixture-layout.spec.ts` saw the difference, and its diagnostic named `bun run migrate:packed-session-fixtures` — a command the [removal proposal](../../proposed/process/2026-07-26-remove-packed-session-fixture-migrator.md) describes as branch-convergence residue. Every refresh therefore wrote a fixture the layout check rejected, and the transitional migrator became a required step of the refresh workflow.

The migrator cannot fully repair the second case. Once the writer has stripped `time0` from a flush-split pair, the gap between the two rows is gone, and re-decoding anchors both rows at time 0; canonicalizing that fixture merges them under a fabricated negative gap.

## Decision

`scrubSessionSnapshot` is the one committed-fixture projection, and record, refresh, and comparison all run it.

It decodes each body record into the logical events it stores — expanding range-encoded `sourceEventSeqs` and packed chunk rows — repacks the whole stream with `packChunkRuns`, and omits the envelopes from the result. A persisted record decodes under its own `seq`/`seq0` and `time`/`time0`; an already-projected fixture record has none, so its position and time 0 stand in, which makes the projection idempotent. The session header line stays byte-identical.

That output is exactly the layout `scripts/session-fixture-layout.ts` calls canonical, so a write-back needs no follow-up fixture migration. `normalizeSessionSnapshot` and `normalizeSessionSnapshots` compose this projection with `normalizeSessionLog` and own no separate comparison-side repack.

Repacking under each record's own time anchor is the one place the writer must not share a zeroing normalizer: committed fixtures carry the real inter-chunk gaps in `dt`, and a flush boundary's gap survives only while the rows still carry `time0`.

## Testing

`scripts/session-fixture-layout.spec.ts` builds a persisted log with the JSONL backend's own `eventLines` encoder and asserts the writer's output is a fixed point of `canonicalSessionFixture`, for a single durable batch and for a chunk run split across two. `packages/test-support/session-snapshot/tests/normalize.spec.ts` pins the projected provenance list, the merged flush-split row, the preserved gaps, and the refusal of a log without a session header.

A keyless `bun run test:snapshot:refresh` rewrites every fixture that lane owns to its committed bytes, and the layout check passes over all 171 repository session fixtures with no migration step. Each of those fixtures is also a fixed point of the projection, so the lanes that refresh the rest write the same bytes.

## Alternatives considered

**Expand `sourceEventSeqs` and leave the packing alone.** Rejected. It closes the encoding that a refresh happened to surface and leaves the flush-boundary encoding, so the migrator stays load-bearing for a case it can only repair by inventing a time gap.

**Reuse the comparison repack in the writer.** Rejected. That helper anchors every row at `time0: 0`, which zeroes every `dt`; the committed corpus records the real gaps, so a refresh would rewrite all 171 fixtures to lose them.

**Widen the canonical layout to accept the storage encodings.** Rejected. The corpus and the comparison path define canonical, and range encoding is a JSONL storage compression: a fixture that has already dropped its seq and time envelopes has no reason to keep the compression built on them.

**Run the migrator after every refresh.** Rejected. It makes a transitional command a permanent workflow step, and its repair of a flush-split run is lossy.

**Delete the migrator in this change.** Rejected as a separate decision the [removal proposal](../../proposed/process/2026-07-26-remove-packed-session-fixture-migrator.md) owns; it still converts fixtures written before this projection.

## Consequences

One projection serves the writer and the comparison, so a storage encoding added at the JSONL boundary must be shed in one place. A future encoding that is missed fails both paths together instead of making them disagree silently.

The write-back validates packed rows while projecting them: a malformed storage row fails the refresh loudly instead of being copied into a fixture. A log whose first record is not a session header, including an empty log, is refused for the same reason.

The layout check keeps its value as an independent oracle: it now confirms a property the writer establishes rather than describing a repair the writer requires.
