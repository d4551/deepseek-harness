# Agent Note: No barrels

Status: implemented

English | [中文](2026-09-03-no-barrels.zh.md)

## Problem

A module that forwards another module's symbols hides where a symbol lives. The import path names one module, the declaration lives in another, and every reader has to follow the chain to find the owner. Forty-six modules in this repository did that, in two forms.

Sixty-seven statements were star re-exports (`export * from './x.ts'`, `export * as ns from './x.ts'`). A star's published surface is whatever the target happens to export today, so no reader of the forwarding module — and no reviewer of a change to the target — can name what it publishes. Adding an export to a leaf module silently widened a package's public API.

Thirty-three modules declared nothing at all and existed only to forward. Some were package entry files, so `main` pointed at a module that owned none of the package's behavior.

## Decision

Both forms are rejected. [`scripts/no-barrels.ts`](../../../../scripts/no-barrels.ts) scans every tracked `.ts`/`.tsx` under `packages/`, `scripts/`, and `apps/`, skipping emitted `lib/` output and the pinned `vendor/` copies, and reports a `star-re-export` for each star and a `pure-barrel` for each module that declares nothing and only forwards. [`scripts/no-barrels.spec.ts`](../../../../scripts/no-barrels.spec.ts) runs it against injected fixtures and against the live tree; `scripts/**/*.spec.ts` is in vitest's default include, so the gate runs in `bun run test` without its own script entry.

A symbol is imported from the module that declares it. A symbol that must cross a package boundary gets a real subpath export whose emitted file is listed in `files` — the shape [`dsh-web-fetch-http`](../../../../packages/web/web-fetch-http/package.json) uses for `./policy`. That package also showed why the emit must be verified rather than assumed: its `./policy` subpath was declared while `lib/policy.js` was never built, so the export had never resolved.

Two modules are not barrels. A module that declares its own API and also names a few forwarded symbols is one. So is a module the package's own `exports` map publishes, even when it declares nothing: that module IS the boundary, and a package whose public surface spans several files states it there rather than making every consumer guess which file owns which name. `isPublishedEntry()` decides this from the manifest, matching a source module against the `lib/` path it emits under, including the Client build's flattening of `src/client/index.ts` to `lib/client.js`.

What the rule removes is the internal forwarder — a module no consumer can import directly, sitting between a caller and the declaration. The first version of this gate did not draw that line and rejected 22 published entries, which is how the distinction was found: `packages/session/session-title/src/client.ts` exists to give the browser half a narrow entry, so deleting it would let the Client reach Host-only modules. Forwarding to restrict is the opposite of the harm.

The gate also caught two bugs in itself. `export type * from` is a star and was invisible to the first pattern, hiding 34 further forwards; and `OWN_DECLARATION` anchored `type[ \t]+\w` with `\b`, which never matched `export type Alpha = …`, so every module whose only declarations were type aliases was reported as a pure barrel. Both have regression cases.

The rule lives in [packages/AGENTS.md](../../../../packages/AGENTS.md) beside the other module-layout rules rather than in the root conventions. It reached the root file first and pushed it past its word ceiling; relocation is what `docs/AGENTS.md` asks for before condensation, and module layout is a package-scoped concern. The `packages/AGENTS.md` ceiling moved from 675 to 710 in [scripts/doc-budgets.manifest.json](../../../../scripts/doc-budgets.manifest.json) to hold the new rule after it had already been condensed twice.

## Alternatives considered

**Ban every `export … from` statement, including named ones in modules that own their API.** That is 751 further statements across 210 modules, and it would make a package's `exports` map the only way to publish anything — dozens of new subpath exports per package, and every cross-package import rewritten. The harm being removed is a symbol whose owner is unfindable; a named forward in a module that owns its API states both the name and its source, so it does not cause that harm.

**Allow star re-exports inside a package and ban them only across boundaries.** The unnameable-surface problem is the same either way: a reader of the forwarding module still cannot say what it publishes, and a new export in the target still widens it silently.

**Rely on review.** Forty-six modules accumulated under review. A rule with no gate regrows.

## Consequences

A symbol's import path now names its owner, so a reader reaches the declaration in one hop and a change to a leaf module cannot widen a package's public surface without an explicit edit to the boundary that publishes it.

The cost is that publishing across a package boundary is now deliberate: a subpath export, its emitted file in `files`, and a build config that actually emits it. That is three edits where a forward was one, and it is the point — each one names what leaves the package.

Package entries that owned nothing had to gain real content or have their `exports` map repointed at the module that owns the behavior, which surfaced packages whose declared entry and actual implementation had drifted apart.
