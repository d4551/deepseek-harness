# Agent Note: Root request budgets and user-owned limits

Status: implemented

English | [中文](2026-09-16-root-request-budget-and-user-settings.zh.md)

## Problem

Applying the delegated-agent ceiling to the root stopped a task at 32 requests even when its shared allowance was 128. An explicit follow-up could renew the episode, but the root reached the same premature ceiling again. Deployment-only policy values also left users without a settings control for finite request limits.

## Decision

The [session accounting owner](../../../../packages/core/session/src/request-budget.ts) limits the root by the shared whole-task ceiling. Each delegated agent remains subject to both its individual ceiling and the shared ceiling. With limits of 32 and 128, one delegate can spend 32 requests and the root can spend the remaining 96; their combined use cannot exceed 128.

The optional agent-loop deployment policy installs one [host settings registration](../../../../packages/core/agent-loop/src/request-budget-settings.ts). The deployment supplies its accounting identity and default limits. Users can change only the two positive safe-integer limits, with the delegated ceiling at most the whole-task ceiling. Agent-initiated settings writes are rejected. Missing configuration creates no request-budget namespace; invalid persisted settings leave the policy unavailable, which the Meowbao request middleware rejects.

The [Model request budget card](../../../../packages/client/ui-settings-plugins/src/client/RequestBudgetCard.tsx) stages both limits and saves them together through the existing settings service. Discard restores the committed values; reset stages the host-supplied defaults. A failed save retains the draft. The card appears in the Plugins settings page under Agent and execution settings.

Namespace registration changes notify the shared settings mirror, so loading or unloading the policy updates the card without a page reload. The spine composition forwards the optional deployment policy to its agent-loop owner; absence remains absence. The generated configuration and service catalogs describe these public contracts.

Every reservation reads the committed limits while retaining the current episode's identity and charges. Saving settings neither admits a human message nor resumes a paused task. An already accepted reservation remains charged through cancellation, provider failure, and subsequent limit changes. Existing episode and attempt events retain their format.

## Alternatives considered

**Increase deployment defaults alone.** This leaves the root subject to the wrong ceiling and provides no user control over the task's finite allowance.

**Automatically renew an exhausted episode.** This removes the explicit human admission boundary and makes repeated automatic work unbounded.

**Expose the accounting identity as a setting.** Changing identity would move accounting to a different policy instead of applying new limits to retained charges.

## Consequences

The root can use the full shared allowance, while delegated work still consumes it. Lowering a limit below recorded usage pauses the next reservation without deleting history. Raising a limit creates additional capacity in the same episode but does not itself start work. Persistence and registration teardown retain the [settings service's existing ownership rules](../architecture/2026-09-01-settings-service-write-and-disposal-integrity.md).

## Verification

The complete [session budget tests](../../../../packages/core/session/tests/request-budget.spec.ts), [agent-loop pause and resume tests](../../../../packages/core/agent-loop/tests/request-budget.spec.ts), and [file-backed settings tests](../../../../packages/core/agent-loop/tests/request-budget-settings.spec.ts) pass together: 43 tests. They cover exact root/delegate counts, authenticated renewal, retained charges across raised and lowered limits, durable save/reset/restart, rejected agent-originated writes, and registration teardown. Scoped type-aware lint and type checks pass for the accounting changes and these tests.

The focused release branch also passes 383 tests across 27 complete files, including settings lifecycle, remote events, spine configuration, and catalog contracts. The official build completes with 292 client artifacts. Three real-browser tests cover the rendered English and Chinese budget card, save/discard/reset behavior, live removal, accessibility, and startup request limits.

Installation of this revision's limit behavior, settings controls, and the separate NES changes has not yet been verified. These checks establish the focused source behavior; they do not certify NES operation or the installed service.
