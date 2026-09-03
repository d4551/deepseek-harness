# Agent Note: apps/web program membership by filename

Status: implemented

English | [中文](2026-09-03-web-program-membership-by-filename.zh.md)

## Problem

`apps/web` straddles both TypeScript check units. Its browser e2e lane boots the host spine and reads Host services (`ctx.connection`, the Host `SessionStore`, `ctx.sessionProjectionCache`), so those files belong to `tsconfig.host.json`; the browser application and the files that mount the Client shell in-process belong to `apps/web/tsconfig.json` under the Client aggregate. Both faces declaration-merge the cordis `Context` interface under the same keys with different services, so one program cannot hold both sides. The partition is real and stays.

The mechanism was two hand-maintained mirror lists. `apps/web/tsconfig.json` excluded 85 host-plane test files by name, and `tsconfig.host.json` included 87 matching names for `apps/web/`. Nothing compared them. Forgetting the Client-side exclusion produced a loud 89-error build failure; forgetting the Host-side inclusion produced a silently unchecked file, and no gate would notice. Two files already sat wrong: `tests/support.ts` was in both programs, and `vite.config.ts` was in neither — it had never been type-checked, and hid three real strict-mode errors in `npmPackageOf`.

## Decision

Membership follows the filename, using the marker the rest of the repository already uses. A `.client.` infix puts a file in the Client program; every other TypeScript file under `apps/web` is in the Host program.

`tsconfig.host.json` includes `apps/web/*.ts`, `apps/web/tests/**/*.ts`, and `apps/web/stress-tests/**/*.ts`, and excludes `apps/web/tests/**/*.client.*` beside the `packages/*/*/tests/**/*.client.*` globs that were already there. `apps/web/tsconfig.json` includes `src` and `tests/**/*.client.*` and carries no `exclude` at all. Ten files gained the infix: `assembled-boot.client.ts` and the nine `*.client.expected.e2e.ts` and `*.client.e2e.ts` scenarios that mount the real shell through it. Those ten are exactly the files that import a `@deepseek-ai/dsh-client-*` package, which is the same set the tests README already documents as the standing exception to its no-Client-imports rule.

Four files that had drifted into the Client project import nothing plane-specific — `support.ts`, `smoke-real.e2e.ts`, `pwa-manifest.e2e.ts`, and `vite-entry.e2e.ts` hold only `node:*`, `playwright`, `execa`, and `ws` — so they carry no infix and type-check in the Host program with the rest of the lane. `support.ts` was genuinely plane-agnostic, not a latent bug; its only Client-side consumer was `smoke-real.e2e.ts`, which moved with it, so nothing needs it in two programs any more.

`vite.config.ts` joins the Host aggregate through `apps/web/*.ts`. It configures the browser bundle but is Node build tooling with no cordis import, and both scripts it imports are already Host roots. It must not join `apps/web/tsconfig.json`: that project sets `rootDir: "."`, so an input from `scripts/` cannot be mapped into `outDir: lib/types` and tsc writes the compiled `.js` and `.d.ts` next to the source instead, where Vite resolves them ahead of the `.ts` being edited.

[`scripts/web-program-partition.ts`](../../../../scripts/web-program-partition.ts) makes the invariant executable. It expands each aggregate and every project its Project References reach, intersects the resolved root files with `apps/web`, and reports any authored `.ts` or `.tsx` file there that no program checks or that both check. It runs inside `bun run constraints`, so `bun run hygiene` and CI carry it. The check is scoped to `apps/web` because `host/webserver`, `compaction/compaction`, and `typert/registry` are deliberate shared leaves that both aggregates type-check; no `apps/web` file has that standing.

## Alternatives considered

**A directory partition — `tests/host/` and `tests/client/`.** This was the first design and it reads well, but it moves 85 files instead of renaming 10, and the cost lands on the fixtures. Goldens resolve through literal `apps/web/tests/expected/<case>/...` paths written inside each test, `*.overlay.yml` files pair with their test by sibling name, and `tests/expected/` mixes cases from both planes, so a directory split has to move or fork the fixture tree as well. It would also invent a second mechanism for a concept the repository already expresses one way, in `packages/*/*/tests`.

**A filename-suffix rule over the existing names.** Not expressible: `pwa-manifest.e2e.ts` and `vite-entry.e2e.ts` are one plane while `agent-team-panel.e2e.ts` is the other, all with the same extension. Marking the minority with a new infix is what makes a glob possible at all.

**Keeping the enumerations and adding only the gate.** The gate alone converts the silent failure into a loud one, which is most of the value, but it leaves both lists to maintain and every new test file still edits two configs in opposite directions. The gate is what makes the class of defect impossible; the infix is what stops it from occurring.

**Marking `support.ts` `.client.` to make the glob work.** That would have kept a plane-agnostic file in the Client program and forced its 81 Host consumers to import across the split. Assigning it and its one Client consumer to the Host program is the resolution the dual membership actually needed.

**Collapsing the four `packages/*/*/tests/**/*.client.{ts,tsx,spec.ts,spec.tsx}` host exclusions into one `*.client.*` glob.** Behavior-identical on the current tree and three lines shorter, but it widens a rule this change does not otherwise touch. Deferred.

**Renaming `scripts/client-bundle-css.spec.ts` and `scripts/client-bundle-purity.spec.ts` to fit `scripts/*.client.spec.ts`.** Not mechanical: `scripts/oxlint-contract.spec.ts` asserts the purity spec's path, and an implemented Agent Note names it as the gate that pins the client-bundle entries. Deferred.

## Consequences

Adding a test to this lane edits no tsconfig. Both configs describe the rule instead of listing its members, and the two lists cannot drift because there are no lists. `tsconfig.host.json` loses 87 lines and gains three; `apps/web/tsconfig.json` loses 85.

Bringing `vite.config.ts` into a program surfaced three `noUncheckedIndexedAccess` errors in `npmPackageOf`, which now derives the package segment from `lastIndexOf('/node_modules/')` and reads the split parts with explicit `undefined` checks. Behavior is unchanged.

Ten renames touched the collection globs' input but not their result: every renamed file keeps its `.e2e.ts` suffix, so `vitest.web.config.ts` still collects it. The web lane collects the same 94 files before and after, the count differing from the previous 93 only by a test another branch landed during this change.

## Testing

`scripts/web-program-partition.spec.ts` builds a repository fixture in three states and pins all three: a total partition passes, dropping `vite.config.ts` from every include reports the unchecked file, and dropping the `.client.` exclusion from the Host program reports the doubly-checked one. On the tree before this change the same gate reported `tests/support.ts` in both programs and `vite.config.ts` in neither, which is how both defects were found.

## Related

[Two-aggregate solution root](../process/2026-07-22-tsconfig-solution-root-two-aggregates.md) owns why the two programs exist. The [browser e2e lane note](../testing/2026-07-24-web-gui-browser-e2e-lane.md) owns the lane itself, and [`apps/web/tests/README.md`](../../../../apps/web/tests/README.md) states the infix rule where authors meet it.
