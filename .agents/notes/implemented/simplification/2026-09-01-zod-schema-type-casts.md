# Agent Note: Zod schemas that asserted their parsed type instead of producing it

Status: implemented

English | [中文](2026-09-01-zod-schema-type-casts.zh.md)

## Problem

Eight hand-written Zod schemas ended in `as unknown as z.ZodType<T>`. The double assertion hid why the inferred type and the declared one disagreed, and each reason turned out to be different: a readonly declaration Zod was never told about, an `exactOptionalPropertyTypes` gap Zod cannot express, a branded id the schema validated as a plain string, and a `discriminatedUnion` whose member shapes genuinely do not overlap the parsed envelope. Read together they looked like one habit; read apart, four of them were removable and one was hiding an unenforced brand.

## Decision

`.readonly()` states the readonly half the projected types declare, which is the same form `packages/typert/generator/src/schema-emitter.ts` already emits for a readonly type — the hand-written schemas had diverged from the generator. That alone clears `list.ts`, `spec.ts`, and two of the three schemas in `model-selection-projection.ts`.

`rpcIdSchema` is `z.string().transform(RpcId)`, so parsing a Connection RPC envelope now *produces* the branded correlation id rather than asserting an unbranded string is one. `RpcId` is an identity at runtime, so no wire behavior changes; what changes is that the brand is established where the value enters.

Four assertions remain and each records its reason at the site. `model-selection-projection.ts` keeps one single `as` because Zod infers `reasoningEffort?: string | undefined` and `exactOptionalPropertyTypes` refuses that against `reasoningEffort?: string`, with no exact-optional form to write instead. `rpc-schema.ts` and `subagent/projection.ts` keep the `unknown` hop because `discriminatedUnion` reports raw member shapes that TypeScript proves do not overlap the parsed envelope (TS2352).

## Alternatives considered

**Widen the declared types to `?: string | undefined`.** That would let the schema match, at the cost of admitting an explicitly-undefined field into a published wire type that `exactOptionalPropertyTypes` exists to keep out.

**Derive the interfaces from the schemas with `z.infer`.** It inverts ownership: `ModelSelection` and `RpcMessage` are wire vocabulary that several packages depend on, and a validation library's inference is not where that vocabulary should live.

**Restructure the discriminated unions so their members carry the parsed type.** The conversion TypeScript refuses is between Zod's own internal shapes, not between the values; reshaping product schemas to satisfy a library's generics trades a recorded assertion for a worse schema.

## Consequences

Four assertions are gone and the four that remain say why, so a reader can tell an unexpressible type from an unexamined one. A Connection RPC id is branded by its parse rather than by a cast downstream of it.
