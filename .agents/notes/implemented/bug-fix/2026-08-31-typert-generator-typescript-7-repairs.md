# Agent Note: Restore typert generator invariants after TypeScript 7

Status: implemented

English | [中文](2026-08-31-typert-generator-typescript-7-repairs.zh.md)

## Problem

The TypeScript 7 migration adapted the typert generator to the new AST and project API, but several invariants did not survive the port, and the generator's own suite could not report it: its vitest workers exhausted the default V8 heap and died, so the failures were invisible. Under a raised heap the workspace analysis peaked at 8.3 GB, and the catalog and doc-graph gates could not run at all.

## Decision

**One compiler graph per face, not per file.** `indexSourceDeclarations` opened a project for every package, and before that a session snapshot for every file, leaving thousands of live graphs. It now runs on the face program, which already covers every package registered to that face, and `WorkspaceCaches.release` drops a memoized project so a batch or a package check cannot retain one. `scripts/cordis-walk` opens its whole file set in one snapshot for the same reason. The client catalog fell from 8.3 GB and 64 s to 0.37 GB and 4 s, the host catalog from an out-of-memory abort to 0.84 GB, and doc graphs to 2.0 GB.

**Write mode annotates parameters before their initializer.** `annotationPosition` fell through to the parameter's end, which sits after any initializer, so `--write` emitted `echo(input = 'value': string)` — source that does not parse.

**A rejected aggregate config fails at load.** TS7's `parseConfigFile` answers with file names alone, so a malformed config or an invalid option value produced an empty discovery instead of a diagnostic. `configFileDiagnostics` opens the config, reads `getConfigFileParsingDiagnostics`, and closes it; the change is announced in its own snapshot because a project opened in the same update is still built from the content the session held before it.

**An empty Cordis augmentation is not a surface.** Package discovery admits a file on a lexical marker; a file whose only marker is an augmentation with no members declares nothing, and the package stays out.

**A Context member that cannot be modeled fails loud.** Resolution returned `undefined` for a service whose type is neither class nor interface, which dropped the declared service from the catalog silently. Within the declaring package that is now a rejection; a member naming a service another package declares is still passed over, because that package models it.

**Ambient declarations belong to the face program.** A package pulls `.d.ts` files in through `types` or `typeRoots`; the face program admitted only files under a package's `src`, so the globals they declare resolved to no declaration.

Recorded model snapshots held absolute paths from the machine that wrote them, against `symbolId`'s own rule that ids are repository-relative; they are re-recorded relative. Cross-package types reached Typert-modeled positions through local re-export barrels in `dsh-client-ui-chat` and `dsh-extensions-ui-cordis`; those sites now import from the declaring package, which is what the analyzer requires.

## Alternatives considered

**Let the analyzer accept a relative barrel that re-exports another package's type.** Rejected: the suite pins that rejection deliberately, because a generated import must name the package that owns the type. The barrel sites were the defect.

**Raise the heap for the generator gates.** Rejected: `scripts/ci-workflow.spec.ts` asserts no `--max-old-space-size` reaches CI, and the retention was a defect rather than a size.

**Keep the migration-era tests that recorded the weakened behavior.** Two of them contradicted older cases on the same fixtures — a tolerated malformed config and a tolerated non-class service member. They recorded what the port did, not what the harness requires, and misconfiguration fails loud here.

**Accept the snapshots as re-recorded by a `-u` run.** Rejected without reading them: the same run rewrote ids that had gone absolute, and only the path normalization and the new `@param` argument names are legitimate.

## Consequences

The generator suite runs to completion on the default heap and passes, so the invariants it encodes are enforced again rather than hidden behind dead workers. Catalog and doc-graph gates run in seconds within the default heap. Write mode produces parsable annotations. A profile or workspace whose aggregate config the compiler rejects now fails at load with the compiler's own message instead of analyzing nothing.
