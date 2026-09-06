# Agent Note: Swarm teammates stop pulling when the board holds no pending task

Status: implemented

English | [中文](2026-09-07-swarm-teammates-stop-on-exhausted-board.zh.md)

## Problem

The swarm policy in `packages/subagent/tool-agent-team` told a teammate to claim with `team_task_claim_next`, and when nothing was available to "use wait_agent and then claim again". It never said when to stop. `claimNextReadyTask()` reported one reason, `no-ready-task`, for two different boards: one where pending tasks remain behind work still in progress, where waiting is right, and one where every task is completed or owned by another member, where nothing a teammate can wait for will ever make a task claimable. A teammate could not tell the two apart without listing the board, and the policy did not ask it to.

`wait_agent` counts a member whose turn is in progress as `running`, and a teammate inside `wait_agent` is exactly that. Two teammates on an exhausted board therefore kept each other alive: each saw the other running, waited out the timeout, re-listed, claimed nothing, and waited again, one model request per cycle, for as long as the session lived. A single teammate fared worse once the Lead had answered: with no active peer, `wait_agent` returned `noProgress` at once, the policy said to claim again, and the loop ran with no delay at all. In the headless `swarm` profile the process ends with the Lead's answer, so the loop was invisible there; in `swarm-web` the session outlives the answer and the teammates kept spending tokens.

## Decision

`TeamTaskClaimUnavailable` has three values, and each tells the caller whether waiting can help. `no-pending-task` means no pending task remains: every task is completed or owned by another member, so nothing becomes claimable until a task is created, released, or reopened. `no-ready-task` now means only that every pending task is blocked by work still in progress. `write-scope-conflict` is unchanged: ready work exists but would write where another member is writing, and `deferred` names it. `TeamTaskBoard.claimNextReady` counts the pending tasks it skipped for readiness and picks the reason from that count and the deferred list, so the distinction is computed in the transaction that decided the claim, not inferred by the model from a later listing.

The swarm policy states the stop rule in the teammate's own terms: `no-ready-task` and `write-scope-conflict` mean `wait_agent`, then claim again; `no-pending-task` means end the turn with a short report of what was completed instead of waiting. The Lead's paragraph says that a teammate ends its turn once no pending task remains, so it must wake one with `followup_task` when it creates more tasks later, and that a task whose owner is inactive will not complete on its own and must be released or reassigned. The tool description carries the same three reasons, the output schema enumerates them, and the delegated policy is unchanged because its teammates are told their work by name.

## Alternatives considered

**Tell teammates to list the board before waiting.** Rejected: it costs a tool call and a model request on every empty claim, and the board already knows, inside the claim transaction, whether a pending task remains.

**Make `wait_agent` return `noProgress` for a teammate when no task is pending.** Rejected: `wait_agent` also observes mailbox and roster changes, and a teammate may legitimately wait for a message from the Lead. The claim result is the one place that knows why the claim found nothing.

**Keep two reasons and add a `pending` count to the result.** Rejected: the model reads the reason as an instruction, and a count it must compare against zero is weaker than a name that says what to do next.

## Consequences

A swarm teammate ends its turn when the board is exhausted, so a `swarm-web` session no longer runs an unbounded claim-and-wait loop after the work is done, and the Lead is told how to wake a finished teammate when it adds tasks. `no-ready-task` narrowed: a caller that previously read it as "nothing left" now receives `no-pending-task` for that board, which the tool description, the subsystem page, and the swarm layer README state. The change reaches only compositions that mount the Team tools, which no shipped default does, so no recorded snapshot changed; the swarm profile still has no recorded session, because recording needs a model key, and its Loader-real composition test plus the Team service and tool suites carry the coverage. Those suites pin the three reasons on an empty board, a board whose only pending task is blocked by in-progress work, and a board where every task is owned, and the tool suite pins the stop rule in the rendered policy.
