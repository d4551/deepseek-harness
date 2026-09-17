---
description: "Reproduce the TypeScript property-signature declarations and verify their installed compiler API."
---

# TypeScript AST declarations

English | [中文](README.zh.md)

## Summary

Validate unannotated TypeScript properties without losing their missing-value checks. The maintained compiler declarations describe absent annotations and initializers, and the generator rejects entries that require an explicit type.

## Table of Contents

- [Reconstruction](#reconstruction)
- [Installed verification](#installed-verification)
- [Source ownership](#source-ownership)
- [Dev Note](#dev-note)

## Reconstruction

Use the Node and Bun versions recorded in [provenance.json](provenance.json), Git, and network access to the recorded official archives and npm packages. Run from the repository root:

```sh
bun tooling/typescript/rebuild.mjs check
```

The command downloads integrity-checked compiler sources and the published package into a fresh directory, installs the frozen [build dependencies](build/bun.lock), applies the [AST schema correction](schema.patch), runs the upstream generator, and strictly compiles the complete JavaScript API. It compares the complete emitted file set with the published API and requires every executable JavaScript file to remain byte-identical. Artifact checking compares the generated patch and all file digests with the recorded artifacts. The command prints the retained reconstruction directory; remove it after reviewing the results.

After changing the schema patch or build inputs, generate and independently check the artifacts:

```sh
bun tooling/typescript/rebuild.mjs rebuild
bun tooling/typescript/rebuild.mjs check
```

Review the schema, build inputs, generated declarations, source maps, and [complete API inventory](artifacts/inventory.json) together. Generated artifacts must come from reconstruction.

## Installed verification

The root package manifest installs the generated [package patch](artifacts/typescript@7.0.2.patch). Run the ordinary installed-distribution tests:

```sh
bun x vitest run scripts/typescript-ast-contract.spec.ts
```

These tests compare every installed API file with its recorded digest, verify that the generator resolves the same compiler package, compile the absent-value contract, execute the real AST factory, and parse annotated and unannotated properties. The generator and catalog suites own validation of their consumers; this distribution check does not establish repository coverage or mutation acceptance.

## Source ownership

The official compiler commit and archive integrity are recorded in [provenance.json](provenance.json). The [schema correction](schema.patch) marks both `PropertySignatureDeclaration.type` and `initializer` as optional in `_scripts/ast.json`. The upstream generator produces the interfaces and factory parameters from that schema. The native compiler and JavaScript execution remain the published implementation. The [generator decision record](../../.agents/notes/implemented/bug-fix/2026-08-31-typert-generator-typescript-7-repairs.md) owns the consumer validation requirement.

The compiler retains its Apache-2.0 license and is disclosed in [third-party notices](../../THIRD_PARTY_NOTICES.md).

## Dev Note

None.
