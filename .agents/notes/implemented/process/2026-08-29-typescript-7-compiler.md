# Agent Note: Compile with TypeScript 7, keep the 6.0 compiler API for its consumers

Status: implemented

English | [中文](2026-08-29-typescript-7-compiler.zh.md)

## Problem

TypeScript 7.0 ships the Go-based `tsc` and does not ship a stable programmatic API; that API lands in 7.1. This repository compiles through `tsc` and also imports the compiler API in the Typert generator and the gate scripts. A single `typescript` major that provided both compile and API in 6.x no longer does both.

## Decision

Compile Host and Client programs with TypeScript 7.0.2 (`typescript` ^7.0.2). Compiler-API consumers import `@typescript/typescript6`, which re-exports the 6.0 API and ships `tsc6` so it does not collide with `tsc`. `typert/generator` declares the package it actually imports.

TypeScript 7 rejects two patterns 6.0 accepted. A name cannot carry an imported type meaning and a locally declared value meaning; `cordis-host-runner` keeps the factories next to their type aliases in `types.ts`. `@ts-expect-error` must sit on the line TypeScript 7 reports, not the line before a multi-line call.

The root README names this compile pin as part of this checkout's toolchain. Contributor setup is in the [development guide](../../../../docs/development.md). The package manager pin is a separate decision in [the bun package-manager Agent Note](2026-08-29-bun-package-manager.md).

## Alternatives considered

**Stay on TypeScript 6.0.3 for compile and API.** Rejected: the Go `tsc` is the compile pin this checkout takes, and the compatibility package exists for the API window.

**Import `typescript` 7 for the compiler API as well.** Rejected: 7.0 has no stable programmatic API. The 31 API importers, 25 of them gate scripts, would break.

**Wait for TypeScript 7.1 and take one package for both jobs.** Rejected: the compile pin is available now. A later 7.1 API bump is independent of the current `tsc` pin.

## Consequences

`bun run typecheck` and `bun run build` run the Go compiler. API-backed gates and Typert keep the 6.0 API until 7.1 ships a stable replacement. Bumping `@typescript/typescript6` is independent of bumping `typescript`.
