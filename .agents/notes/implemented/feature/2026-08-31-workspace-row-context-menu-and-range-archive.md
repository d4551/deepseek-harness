# Agent Note: Workspace row context menu and range archive

Status: implemented

English | [中文](2026-08-31-workspace-row-context-menu-and-range-archive.zh.md)

## Problem

Every verb in the sidebar's browsing region sat behind one affordance: a 16px **...** button that only appears while the pointer rests on the row. Reaching Rename, Fork, or Archive meant hovering the right row, finding the button, and clicking it — the right-click every desktop list answers did nothing. Archiving was also strictly one row per gesture, so clearing a run of finished Sessions cost one hover, one button, and one menu selection each.

## Decision

Both row kinds answer a right-click anywhere on the row with the same list the **...** button opens. `useRowMenu` in `packages/client/ui-workspace/src/client/rows/Rows.tsx` owns that state for both: it holds the open flag and, when a right-click opened the list, the pointer position. It hands `Menu` a `getAnchorRect` returning a zero-size `DOMRect` at that pointer, so the list places itself under the cursor instead of at a button the row reveals only on hover; opening from the button drops the point and `Menu` measures its own wrapper as before. Rows with no verbs keep the platform menu: the provisional blank **New Session**, which renders no trailing actions at all, and the Ungrouped bucket header, which has no backing Workspace.

Both row kinds carry one range selection, held by `useRowSelection` in `packages/client/ui-workspace/src/client/selection.ts`. The grouped tree and the flat list own one selection each, keyed on the rows they render in render order. In the grouped tree that account is every real Workspace header followed by the session rows under it, so clicking a project and shift-clicking a lower project selects everything between them — headers and sessions alike — exactly as the operator reads the list. The Ungrouped bucket stays out of the account: it has no backing Workspace and no row verbs. Keys carry their kind (`session:` / `workspace:`) so the two id spaces cannot collide in one ordered account.

A plain click anchors the range and empties the selection before the row does its own work — opening the Session, or folding the project. Shift-click selects the inclusive slice from the anchor; Ctrl/Cmd-click adds or removes one row and re-anchors; Escape withdraws the selection through a document listener, because the rows are not focusable and the list has no keyboard seat. Membership is reconciled on read against the rendered keys, so a row that is archived, folded away, or filtered out by a search leaves the selection with no separate pass. A right-click on a row outside the selection narrows the selection to that row first, the platform rule.

A selected Workspace row stands for its members, so `GroupNode` carries `memberIds`: every session a group-wide action reaches, in local order, independent of expansion and excluding the provisional blank New Session. A folded project therefore answers for its sessions instead of contributing nothing. Because a header inside a range can reach sessions the operator never clicked, the marking is driven by the reach rather than by raw membership: a session row marks when the resolved set contains it, so the highlighted rows are exactly the rows a bulk action would archive, and a selected project visibly claims its members.

With two or more rows selected, every row menu in the list drops its per-row verbs — Rename, Fork, Delete, and single Archive all address one row — for one **Archive N sessions** row. `N` counts the reached Sessions, not the selected rows, and the row is disabled rather than absent when a range of empty projects reaches none. Committing it calls `archiveSession` once per reached id, deduplicated in rendered order, and clears the selection immediately rather than waiting for the archive-set echo that removes the rows. No new wire operation exists: `workspace.archiveSession` takes one Session, the registry serializes its writes behind one operation chain, and every reply carries the complete archive set, so the last echo to land is correct whatever order the calls settle in. Selection is transient view state and is never persisted; it dies with the mounted list, including a switch between the grouped and flat presentations.

Selected rows take `css.multiSelected` — the hover fill plus a leading accent rule, so a run reads as one block next to the single current-Session highlight it can overlap — and report `aria-selected`; both list containers declare `aria-multiselectable`. A visually hidden `role="status"` reports the reached Session count, since the marking is the only other channel.

## Alternatives considered

**Add a bulk `archiveSessions` wire operation.** Rejected: the client gains nothing an N-call fan-out does not already give it. The registry already serializes archive writes behind one chain and each reply carries the whole set, so a batch call would buy atomicity no surface depends on, at the cost of a new request type across the Typert graph, both SDKs, and their expected outputs.

**Restrict the range to session rows.** Rejected: it fails the request, which is to click a project and shift-click a lower project. It also reads as arbitrary — the header is a row in the same list, under the same pointer, in the same reading order.

**Let a selected header contribute its members without marking them.** Rejected: a header caught in the middle of a range would archive sessions below the operator's shift-click, outside anything highlighted. Driving the marking from the resolved reach keeps the visible selection and the committed set the same set.

**Archive the Workspace itself.** Rejected: no such operation exists — a Workspace has Delete, which removes a registration and is not what a bulk archive means. A selected project resolves to its Sessions and the Workspace registration is untouched.

**Keep the per-row verbs alongside the bulk row.** Rejected: Rename and Fork address one Session, so offering them while three rows are selected leaves the target unstated. The widened list carries the one action that is defined for a set.

**Give `Menu` a first-class point-anchoring mode.** Rejected: the existing `getAnchorRect` escape already expresses "place against this rect", and a zero-size rect at the pointer is exactly that. A second placement mode in the primitive would have one caller.

**Add selection to search results.** Rejected: the result list is a ranked projection over a query, not an account with a stable order, and its rows already navigate on click.

## Consequences

A right-click reaches every row verb without a hover hunt, and clearing a run of finished Sessions — or several whole projects — is one click, one shift-click, and one menu selection instead of N hovers. The bulk archive fans out one request per reached Session, so a range over large projects issues a burst of RPCs; nothing bounds it today, and each rejection logs the same non-fatal `session archive rejected:` diagnostic the single-row action logs. A plain click on a project both anchors the range and folds the group, since anchoring must not take that click's existing meaning away. Escape now clears a live selection anywhere in the document, which also closes an open row menu in the same keystroke.

Unit coverage pins `rowRange`, the key namespaces, and the selection gestures directly (`packages/client/ui-workspace/tests/selection.client.spec.tsx`); `tests/tree.client.spec.ts` pins that a folded group still reports its members and that the blank draft and archived rows never enter them. Row behavior pins the pointer placement, the blank-row and bucket exemptions, the modified-click routing on both row kinds, and the widened menu including its singular label and its inert empty case (`tests/rows.client.spec.tsx`). The assembled browser pins a session range inside one group, a project-to-project range over three folded projects archiving all four of their Sessions in rendered order, the member marking a selected project claims, and the flat-list Ctrl-pick with its Escape withdrawal (`tests/workspace-browser.client.spec.tsx`).
