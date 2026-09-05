# Agent Note: Capacity gate mutation equivalent

Status: implemented

English | [中文](2026-09-05-capacity-gate-mutation-equivalents.zh.md)

## Problem

Mutation testing can alter the capacity waiter abort callback after settlement without changing behavior available through a real AbortSignal. A test that invokes a captured callback after the gate detaches it would measure private machinery instead of the acquisition contract.

## Decision

The capacity-gate suite asserts the exact closure error object, one handoff when grant and abort occur together, removal of a cancelled middle waiter without disturbing FIFO order, and abort-listener counts before and after settlement. A real AbortController and Node getEventListeners show one listener while a waiter is queued and zero after either grant or close. These assertions cover error ownership, single slot settlement, queue cleanup, and listener lifecycle through platform operations.

ConditionalExpression mutant 84 at packages/util/capacity-gate/src/index.ts:174 is the sole equivalent survivor: it replaces the index < 0 guard in the abort callback with false. Grant and close detach the callback synchronously before settling the waiter promise. An abort dispatched before settlement therefore sees the waiter in the queue, while an abort dispatched afterward cannot invoke that detached callback. The post-grant signal check owns the separate race in which the signal aborts after the slot is granted but before the caller resumes.

This record specializes the repository's [mutation-testing policy](2026-06-11-mutation-testing.md). The measured survivor remains visible in the report; the configuration carries no operator, line, or file exclusion.

## Alternatives considered

**Invoke the detached callback directly.** Rejected because the callback is not part of the package API and a real AbortSignal cannot dispatch it after removal.

**Exclude the equivalent mutant.** Rejected because an exclusion can hide a later observable defect on the same line; the measured report and this equivalence proof retain the distinction.

## Consequences

The focused capacity run records 74 killed, 26 timed out, one survived, and none without coverage across 101 mutants. Its 99.01% mutation score passes the 99% break threshold. The survivor remains visible for review without excluding its file, line, or mutator.
