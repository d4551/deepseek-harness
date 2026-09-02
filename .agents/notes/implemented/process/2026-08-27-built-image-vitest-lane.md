# Agent Note: Built-image suites run in their own vitest lane

Status: implemented

English | [中文](2026-08-27-built-image-vitest-lane.zh.md)

## Problem

`packages/experimental/webworker-packer/tests/image-loadable.spec.ts` did two unrelated jobs in one file inside the unit lane: fast source-tree assertions over repository knowledge (workspace indexing, config trees, preview fixtures, pack reporting) and slow fixtures that materialize emitted `lib/` and load it through the real runtime image loader. The [coverage-exempt roster](2026-07-31-coverage-exempt-heavy-suites.md) exempted the whole file as heavy, so a broken unit assertion and a missing emitted bundle were indistinguishable, and the unit half paid an instrumentation tax it never needed.

## Decision

Split by plane, following the repository's source-plane/artifact-plane rule:

- Unit lane (`vitest.config.ts`, instrumented): `vfs-overlay.spec.ts` packs overlay archives from source trees; `image-loadable.spec.ts` covers repository knowledge only.
- Built lane (`vitest.built.config.ts`, `forks` pool, one file per process): `*.built.ts` suites materialize emitted `lib/` and require it through the real image loader. They run as the `built-image-specs` gate in `scripts/run-gates.ts`, inserted after `built-artifact-specs` in `ci-primary` and `ci-artifact`, declaring `build` as their need.
- The roster entry is gone: the built lane sits outside the coverage aggregate entirely, so no exemption is needed; knip reaches `tests/*.built.ts` through an explicit workspace entry in `knip.json`.

## Verification

- `bun run vitest run packages/experimental/webworker-packer/tests/image-loadable.spec.ts packages/experimental/webworker-packer/tests/vfs-overlay.spec.ts` — unit half, green.
- `bun run vitest run --config vitest.built.config.ts` — 10 built cases, no skips.
- `bun run vitest run scripts/run-gates.spec.ts` — aggregate graph covers the new gate.
- `bun run knip` — `tests/*.built.ts` reachable.

## Alternatives considered

- **Keeping the single exempt suite and re-fixing its comment.** Rejected: the instrumented/uninstrumented split still conflated unit assertions with artifact availability, and every new packer test would have to choose between inheriting the exemption or dragging subprocess fixtures into the unit lane.
- **A separate vitest project inside `vitest.config.ts`.** Rejected: the unit config resolves workspace imports through tsconfig `paths` to `src`, while the built suites must resolve emitted `lib/`; one config cannot hold both resolutions without lying about one plane.

## Consequences

- A never-emitted or stale `lib/` fails `built-image-specs` loudly instead of being skipped or dragging unit coverage.
- New packer tests choose a plane by what they read: source trees → `*.spec.ts`; emitted output → `*.built.ts`.
