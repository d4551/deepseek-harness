# Agent Note: Workspace row context menu and range archive

Status: implemented

English | [中文](2026-08-31-workspace-row-context-menu-and-range-archive.zh.md)

## Problem

Every verb in the sidebar's browsing region sat behind one affordance: a 16px **...** button that only appears while the pointer rests on the row. Reaching Rename, Fork, or Archive meant hovering the right row, finding the button, and clicking it — the right-click every desktop list answers did nothing. Archiving was also strictly one row per gesture, so clearing a run of finished Sessions cost one hover, one button, and one menu selection each.

## Decision

Both row kinds answer a right-click anywhere on the row with the same list the **...** button opens. `useRowMenu` in `packages/client/ui-workspace/src/client/rows/Rows.tsx` owns that state for both: it holds the open flag and, when a right-click opened the list, the pointer position. It hands `Menu` a `getAnchorRect` returning a zero-size `DOMRect` at that pointer, so the list places itself under the cursor instead of at a button the row reveals only on hover; opening from the button drops the point and `Menu` measures its own wrapper as before. Rows with no verbs keep the platform menu: the provisional blank **New Session**, which renders no trailing actions at all, and the Ungrouped bucket header, which has no backing Workspace.

Session rows carry a range selection, held by `useRowSelection` in `packages/client/ui-workspace/src/client/selection.ts`. The grouped tree and the flat list own one selection each, keyed on the rows they render in render order: the grouped account concatenates every open group's rendered rows, so shift-clicking a row further down selects across Workspace group headers exactly as the operator reads the list. A plain click anchors the range and empties the selection before opening the Session; shift-click selects the inclusive slice from the anchor; Ctrl/Cmd-click adds or removes one row and re-anchors; Escape withdraws the selection through a document listener, because the rows are not focusable and the list has no keyboard seat. Membership is reconciled on read against the rendered ids, so a row that is archived, folded away, or filtered out by a search leaves the selection with no separate pass. A right-click on a row outside the selection narrows the selection to that row first, the platform rule.

With two or more rows selected, the row menu drops Rename, Fork, and Archive — all single-Session verbs — for one **Archive N sessions** row. Committing it calls `archiveSession` once per selected id and clears the selection immediately, rather than waiting for the archive-set echo that removes the rows. No new wire operation exists: `workspace.archiveSession` takes one Session, the registry serializes its writes behind one operation chain, and every reply carries the complete archive set, so the last echo to land is correct whatever order the calls settle in. Selection is transient view state and is never persisted; it dies with the mounted list, including a switch between the grouped and flat presentations.

Selected rows take `css.multiSelected` — the hover fill plus a leading accent rule, so a run reads as one block next to the single current-Session highlight it can overlap — and report `aria-selected`; both list containers declare `aria-multiselectable`. A visually hidden `role="status"` reports the live count, since the fill is the only other channel.

## Alternatives considered

**Add a bulk `archiveSessions` wire operation.** Rejected: the client gains nothing an N-call fan-out does not already give it. The registry already serializes archive writes behind one chain and each reply carries the whole set, so a batch call would buy atomicity no surface depends on, at the cost of a new request type across the Typert graph, both SDKs, and their expected outputs.

**Let the range span Workspace header rows too.** Rejected: a Workspace has no archive operation, only Delete, so a selected header could only contribute its sessions — inventing a "archive this whole project" gesture nobody asked for, with a collapsed group's hidden rows as its ambiguous membership. Headers are skipped when the range is computed; the range still crosses them.

**Keep the per-row verbs alongside the bulk row.** Rejected: Rename and Fork address one Session, so offering them while three rows are selected leaves the target unstated. The widened list carries the one action that is defined for a set.

**Give `Menu` a first-class point-anchoring mode.** Rejected: the existing `getAnchorRect` escape already expresses "place against this rect", and a zero-size rect at the pointer is exactly that. A second placement mode in the primitive would have one caller.

**Add selection to search results.** Rejected: the result list is a ranked projection over a query, not an account with a stable order, and its rows already navigate on click.

## Consequences

A right-click reaches every row verb without a hover hunt, and clearing a run of finished Sessions is one click, one shift-click, and one menu selection instead of N hovers. The bulk archive fans out N requests, so a very large range issues a burst of RPCs; nothing bounds it today, and each rejection logs the same non-fatal `session archive rejected:` diagnostic the single-row action logs. Escape now clears a live selection anywhere in the document, which also closes an open row menu in the same keystroke.

Unit coverage pins `rowRange` and the selection gestures directly (`packages/client/ui-workspace/tests/selection.client.spec.tsx`), row behavior pins the pointer placement, the blank-row and bucket exemptions, the modified-click routing, and the widened menu (`tests/rows.client.spec.tsx`), and the assembled browser pins a cross-group shift range archiving both Sessions plus the flat-list Ctrl-pick and its Escape withdrawal (`tests/workspace-browser.client.spec.tsx`).
