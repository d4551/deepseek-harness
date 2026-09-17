# Agent Note: Reject empty invariant installers

Status: implemented

English | [中文](2026-09-16-reject-empty-invariant-installers.zh.md)

## Problem

An empty invariant installer reserves a package name without checking its behavior. Accepting an explanatory comment as proof of enforcement lets documentation conceal missing checks. The repository's no-op prohibition requires the package gate to report this missing implementation.

## Decision

The [package invariant gate](../../../../scripts/package-invariants.ts) rejects empty installer bodies, including function expressions and installers carrying injected services through `Object.assign`. Comments grant no exemption. Publication, exact-name registration, Loader shape, and failure-reporter requirements remain enforced.

This removes the empty-installer allowance in [Meaningful package invariant contracts](../architecture/2026-07-19-package-invariant-runtime-contracts.md). That note remains the owner of meaningful event/data checks and the prohibition on synthetic method-presence assertions. Registering a name, calling an empty function in a test, or asserting a fixed example cannot substitute for checking an owned runtime relationship.

## Verification

The owning gate suite proves that commented and uncommented empty arrows, empty function expressions, and injected empty installers fail. A real event-listener installer remains accepted. The complete repository scan reports all remaining empty installers and exits unsuccessfully; those findings remain implementation debt.

## Alternatives considered

- **Keep comment-based exemptions.** Rejected because a justification is not an executable check and contradicts the no-op prohibition.
- **Populate installers with generic presence assertions.** Rejected because these assertions duplicate type/load checks without detecting inconsistent runtime state.
- **Delete companions to remove findings.** Rejected because that abandons the existing package publication and registration requirement.

## Consequences

The gate exposes missing checks even when a package has no obvious observable state. Its structural check does not prove semantic correctness: each companion still needs source review and valid/invalid runtime evidence. The gate repair does not implement the outstanding companions or establish complete coverage, mutation acceptance, or full green.
