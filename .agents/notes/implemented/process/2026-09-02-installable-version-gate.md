# Agent Note: A gate for the direction the floors cannot see

Status: implemented

English | [中文](2026-09-02-installable-version-gate.zh.md)

## Problem

Two gates hold the stack down. `verify-toolchain-floors` refuses a root manifest whose toolchain pins fall below a stated major/minor, and `live-stack-floors` does the same for the compile and client stack. Both catch a downgrade, which is the failure a coordinated edit can produce while every other gate stays green.

Neither catches the opposite drift. A floor written at the version installed today is correct today and silently wrong a year later: nothing compares either table to what the registry has published, so every pin can fall arbitrarily far behind with all of `check-all` green. The floors exist to stop the stack rotting and cannot see the way it actually rots.

## Decision

`verify-installable-versions` fails when a dependency is behind a version this workspace could install, and runs in `check-all` beside the floor gates.

The report comes from `bun outdated`. Asking the registry directly would mean reimplementing range resolution, workspace filtering and the `minimumReleaseAge` hold in `bunfig.toml`, and the answer would drift from what `bun install` does; the package manager already knows all three.

A version the hold is withholding is reported and passes. That hold is this repository's supply-chain policy, so failing on it would make going green require bypassing it — the gate would be demanding a security regression.

The check reads the newest published version, not `bun outdated`'s in-range `Update` column. An exactly pinned dependency has an in-range target equal to what is already installed, so a check against that column can never fire; written that way in the sibling repository first, it passed a deliberate downgrade.

Landing it moved `jscpd` to 5.1.1 and `knip` to 6.34.0. The `jscpd` bump immediately reported a fourteen-line clone in `run-gates.ts` that 5.0.16 did not detect: the gates consuming the built tree were listed once in `check-all` and again in the artifact lane, so a gate added to one lane and not the other would run in CI and not locally. They are one function now.

## Alternatives considered

**A scheduled dependency bot.** It opens pull requests; it does not fail a gate, so a branch that ignores it still merges green. The two are complementary, and only one of them is a gate.

**Reading the registry directly.** Rejected for what it would have to reimplement: ranges, workspaces, and the hold. Every one of those is a place for the gate's answer to diverge from what `bun install` would actually do, and a gate that disagrees with the installer is worse than no gate.

**Failing on held versions.** It would make the supply-chain hold and this gate mutually unsatisfiable, so the only way to green would be to shorten or bypass the hold.

## Consequences

A dependency publishing a new version now fails a gate once it clears the hold, so the bump is taken deliberately rather than whenever someone notices. That is one more reason a green branch goes red without anyone touching it, and it is the point: the alternative is the pin rotting where no gate looks.

The gate depends on the registry being reachable. Where it is not, it fails loudly rather than passing quietly, which is the behaviour a version gate should have.
