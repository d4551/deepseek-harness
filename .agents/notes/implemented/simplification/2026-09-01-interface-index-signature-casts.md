# Agent Note: Casts that existed because a target was an interface

Status: implemented

English | [中文](2026-09-01-interface-index-signature-casts.zh.md)

## Problem

Code that reads a decoded record — a SQLite row, an MCP content block, an LSP wire object — routinely ended in `value as unknown as RowType`. The `unknown` hop was not laziness about the value; it was TypeScript refusing the conversion outright, because an `interface` has no implicit index signature and therefore does not overlap `Record<string, unknown>`, `Record<string, SQLOutputValue>`, or `{ [key: string]: JsonValue }`. Every author hit the same compiler wall and wrote the same escape, which then also hid whether anything had checked the value at all. In `lsp-stdio` two full structural checks already existed and returned `boolean`, so the cast beside them looked like validation nobody had done.

## Decision

Where the target type is declared in the same package, it is a `type` alias rather than an `interface`, which carries the implicit index signature the conversion needs. That turns each site into either no cast or one narrowing:

`session-query-sqlite` row types are aliases, so four `.all() as unknown as Row[]` reads are one `as` each, with the reason recorded once: the `SELECT` names the columns the row type declares, and the schema is owned in that module under a monotonic `SCHEMA_VERSION`.

`lsp-stdio`'s `isLocationLink` and `isLocation` declare `value is WireLocationLink` / `value is WireLocation` instead of `boolean`, so the two casts beside them are gone and the checks that were already running now narrow.

`core/tools`'s `JsonSchemaNode` is the largest instance: as an alias it satisfies `Record<string, unknown>` directly, so `defineTool` passes its compiled parameters through with no conversion, and the compiler then proved twenty-one further assertions across `ts-types` and the tool-schema specs unnecessary — oxlint's `no-unnecessary-type-assertion` names each one. Changing the declaration keyword also moves the `type-equiv` block in `docs/subsystems/tools.md`, the one in `docs/subsystems/persistence.md`, and one generated catalog entry each time, because all three record the declaration verbatim. A conversion is therefore never source-only: `verify-type-equiv` and `gen-cordis-api --check` both have to run.

`core/session`'s `SessionHeader` is the same wall at the durable boundary: `validateSessionHeader` checks every field by hand and then had to launder the record back, because the type it proved could not overlap the record it held. As an alias the return states what those checks proved, in one narrowing rather than two.

`mcp-client` replaced its two casts with `toMcpContentBlock`, which keeps only the fields a remote server declared as strings. A `data` that arrives as a number is absent rather than typed `string`, so the image branch reports `the image data is not canonical base64` instead of reading a number through a string seat.

## Alternatives considered

**Add an index signature to each interface.** It admits every unrelated key into a type whose point is the exact field set, and it would weaken excess-property checking at every construction site.

**Validate each field at every read site.** `mcp-client` does exactly this, because its input is a remote server's payload. `session-query-sqlite` does not, because the row shape is fixed by a `SELECT` written three lines above against a schema the same module owns; per-row validation there would price a hot search path for a shape no other code can change.

**Leave the hop and document it.** That is right for the conversions TypeScript proves impossible — Zod's `discriminatedUnion` member shapes — and wrong here, where the wall came from a declaration style rather than from the types disagreeing.

## Consequences

Twenty-three of the repository's `as unknown as` sites are gone along with twenty-one redundant single assertions, and the ones that remain in these files say why. A reader meeting this compiler wall now has a fix that removes the cast rather than a precedent for writing another one.
