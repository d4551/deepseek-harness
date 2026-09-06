# Agent Note: Silent gate exclusions become measured gates

Status: implemented

English | [中文](2026-09-06-measured-gates-over-silent-exclusions.zh.md)

## Problem

Four checks reported success while measuring less than their name claimed.

[`knip.json`](../../../../knip.json) carried `"exclude": ["duplicates"]` with no comment, no Agent Note, and no other check covering the issue type, so knip's duplicate-export detector was off repository-wide. Behind it sat one real duplicate: `WRAPPER_PARAMS` in [`image-layout.ts`](../../../../packages/experimental/webworker-runtime/src/image-layout.ts), an alias whose own JSDoc said it existed so existing imports would stay exact — the compatibility shim the pre-release stance forbids.

[`ROOT_DEPENDENCY_FLOORS`](../../../../scripts/live-stack-floors.ts) named `@stryker-mutator/vitest-runner` after the manifest stopped declaring it. `rangeMisses` skips a name it cannot find, so the entry evaluated nothing while its JSDoc claimed the map was complete by construction; completeness was asserted in one direction only.

[`browser-locale`](../../../../packages/util/browser-locale/src/index.ts) held a `Stryker disable next-line ArrayDeclaration` comment. The mutant it suppressed was genuinely equivalent, but suppression is the mutation tier's escape hatch: it records that a mutant is unkillable instead of removing the construct that makes it unkillable.

## Decision

Each hole becomes something that measures.

`bun run verify-duplicate-exports` ([`knip-duplicate-exports.ts`](../../../../scripts/knip-duplicate-exports.ts), hygiene lane) runs knip's own duplicate detector and classifies every row. Two names for one binding pass only when one of them is `default` — the Cordis plugin convention, where a Service class is exported by name for typing and as `default` for `ctx.plugin()` — or when the file appears in a name-scoped exception list, which today holds only the `ws` stub that must publish that package's own `WebSocketServer` and `Server` names. Anything else fails. The knip.json exclusion stays, because 93 of the 94 live rows are that convention and a repository-wide failure would teach readers to ignore the gate; what changed is that the excluded class is now measured somewhere and said out loud in [`docs/development.md`](../../../../docs/development.md).

`staleRootDependencyFloors` and `stalePinnedProductFloors` close the floor map's second direction: a floor naming a dependency no manifest declares is now a failure, not a silently skipped row. `WRAPPER_PARAMS` is deleted and its one consumer reads `MODULE_PARAMS`.

`resolveBrowserLocale` is restructured rather than suppressed. The `??` whose two mutants no test could distinguish became an explicit `browser.languages === undefined` branch, and the empty-array fallback became an early `return 'en'`; every remaining mutant on those lines is killable, and two tests were added that kill them — an embedder reporting an empty `languages` list, and explicit tags overriding a live browser.

## Alternatives considered

**Delete `"exclude": ["duplicates"]` and let `bun run knip` report all 94.** Rejected: 93 are a framework requirement, so the gate would fail permanently on correct code and be routed around within a week.

**Hand-roll a duplicate-export scan over the TypeScript AST.** Rejected by the dependencies-over-hand-rolling policy: knip already computes this, and a second implementation would drift from it.

**Keep the Stryker suppression and document why the mutant is equivalent.** Rejected: the comment was already accurate, and it still left a construct in the tier that no assertion can reach. Removing the construct is available here and costs three lines.

**Assert the floor map's completeness by listing expected names.** Rejected: a copied expected list is edited to match whatever the manifest says, which is the failure mode the map exists to prevent. Deriving both directions from the manifest cannot be satisfied that way.

## Consequences

Adding a root dependency still forces a floor; removing one now forces deleting it. A module that exports one binding under two names fails the hygiene lane unless it is the plugin convention or is named in `NAMED_ALIAS_EXCEPTIONS` with its exact name set, which is per-file and cannot be inherited. `bun run verify-duplicate-exports` costs about 45 seconds because it drives a full knip analysis, which is why it runs in hygiene rather than the unit lane. A future mutant suppression in `packages/util/*/src` is a signal that the source, not the test, is what needs changing.
