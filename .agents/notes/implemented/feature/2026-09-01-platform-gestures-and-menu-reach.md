# Agent Note: Platform gestures and reach in the row lists

Status: implemented

English | [中文](2026-09-01-platform-gestures-and-menu-reach.zh.md)

## Problem

The workspace row gestures ([the gesture note](2026-08-31-workspace-row-context-menu-and-range-archive.md)) and their keyboard account ([the keyboard note](2026-09-01-workspace-row-keyboard-account.md)) read the pointer as if every host spent its buttons the same way, and left three reaches short of the patterns they claim to implement.

Apple platforms answer Ctrl+click with the secondary menu. WebKit dispatches a `click` for that press as well as the `contextmenu`, so a row reading Ctrl as the range's additive modifier toggled the row and opened its menu from the one gesture; and the `contextmenu` that press sends reports the primary button, so the row read a cursor press as a keyboard request, anchored the list against the row instead of the cursor, and took the focus into it from under the operator's hand.

The search results declare `role="tree"` but rendered plain buttons: every result was its own tab stop, the arrows did nothing there, and no row reported a level. A list of fifty matches cost fifty Tab presses to pass.

`Menu` disabled its unavailable rows with the native attribute, which takes them out of the focus order entirely; the arrows skipped them and a reader never announced them. The menu pattern requires the opposite — an inert row is focusable and refuses its activation.

The **Show N more** row a folded group holds was a plain button inside `role="tree"`: not a `treeitem`, and a tab stop of its own, so a sidebar of five folded groups cost six tab stops in a list that promises one. Neither it nor a search result drew a seat ring of its own, so both fell back to the page's outward one, which a list that scrolls — and therefore clips on both axes — cuts off at the edges. The row-level accessibility audit could not see any of this — it renders one row inside a hand-built `tree` and never the assembled region.

Neither tree answered a printable character. The tree pattern asks for type-ahead on any tree past a handful of rows, and a sidebar of sessions is exactly that: without it the only way to a row fifty down is fifty arrow keys.

The seat's focus recovery latched on the first arrow key and never unlatched. From then on any reconcile that found the focus on the body pulled it back into the list, including long after the operator had left the sidebar for another control that then went away itself.

## Decision

`packages/client/ui-workspace/src/client/pointer-platform.ts` owns the two platform readings, taken per gesture from `navigator.platform` so a test can name the host. `additiveModifier` is Cmd on Apple platforms and Ctrl everywhere else — it answers for the click that adds one row and for the A that takes the whole account, which is one platform rule and so one home — and `secondaryPress` reads button 2 anywhere plus an Apple Ctrl+click. `useRowMenu` anchors and seats the list by `secondaryPress`. The click that press also dispatches is swallowed by a signal the row already holds rather than by the platform: `selectionTookClick` refuses any click arriving while this row's menu is up. That is the same rule a click under any open list follows — the press dismisses the list and does nothing to the row — and it holds even where `navigator.platform` misreports, so no host can act twice on one press.

The search results take the same roving seat the two session lists use, over `useRowFocus` in `SearchResults`. Each result reports `aria-level`, its key, and the list's single tab stop; the arrows and Home/End move it, and Enter opens the focused result. They are one level with no range over them, so Shift carries nothing, Space keeps the page scroll, and a result reports the open Session through `aria-current` rather than promising a selection state no range can produce — the rule the session rows already keep for the rows a range cannot reach.

One seat constructor serves all of it. `rowSeat` takes the range a row can carry rather than a flag saying whether it can: a row with no range passes none, which is one signal instead of two that had to agree, and the search results build their seats through the same call as every other row.

The overflow row takes a seat in its list's account like every other rendered row, and renders as a `treeitem` at the depth of the sessions it reveals. It carries no `aria-expanded`: on a tree row that attribute promises child nodes the row itself owns, and the rows this one reveals are its siblings. Its label already says which way the next activation goes. Its navigation keys route through the same `rowKeyDown` the two row kinds use, which takes Enter's default away with it, so the row opens once rather than twice; Space goes unanswered there and keeps the button activation the browser already gives it. No range reaches it, on the same terms as the Ungrouped bucket header.

Both rows now draw the same inset ring the session rows do.

A printable character with no command modifier searches the list by label. `useRowFocus` collects the characters for `TYPE_AHEAD_MS` and moves the seat to the next row whose label starts with them, wrapping through the head of the list; a buffer of one character searches past the row it came from, so repeating a character walks the rows that begin with it, while a longer buffer starts at that row and keeps refining it. Rows publish their label as `data-row-label` beside the key they already publish, for the same reason the focus moves by attribute: the searching row cannot reach its siblings and the list owns the element they render into. A type-ahead moves the focus alone — it names a row rather than sweeping the rows between, so it has no range to carry.

`Menu` marks an unavailable row with `aria-disabled` instead of the native attribute, keeps every row in the arrow ring, and refuses the activation in the row's own handler. Such a row also opens no submenu and announces no popup, because the nested card it can never show is not an affordance. `Menu.module.css` styles the inert row by that attribute, and `tests/menu-styles.client.spec.ts` pins that coupling — jsdom applies no CSS-module rule, so nothing else would notice the stylesheet still keyed off a `:disabled` state the row stopped carrying.

`useRowFocus` watches whether the focus is inside its list from document listeners rather than latching on the first move. `focusin` says where the focus landed. `focusout` gives the recovery up only when the blurred element is still in the document — a focus the operator dropped on purpose — because a row that leaves takes the focus with it and reports that blur with the row already detached, or, under jsdom, reports none at all. The recovery itself is checked after every render, not only when the seat changes: the focus can sit on a row the arrows never visited, and archiving that row leaves the reconciled seat untouched.

## What the pattern still leaves out

Both trees follow the tree pattern's no-modifier selection model: Space toggles the focused row, Shift with an arrow or with Space carries the range, and the platform's additive modifier with A takes the whole account at once, anchored at its head so a following Shift move narrows from there. `Ctrl+Shift+Home`/`End` are not here: the range they would build is the one Shift with an arrow already builds a row at a time, from an anchor select-all has just set.

Shift from a row no range reaches — the Ungrouped bucket header, a provisional blank draft, a folded group's overflow row — moves the focus and carries nothing, because such a row is not in the account and so cannot anchor a slice of it. Shift *across* one carries as it always did: the account is the visible reading order, and the rows on either side of an unreachable one are still neighbours in it.

## Alternatives considered

**Swallow the companion click by asking the platform for it too.** Rejected: the platform reading is a good enough answer for placement, where being wrong costs a menu opened against the row instead of the cursor, and a poor one for safety, where being wrong costs a range edit the operator never asked for. The row's own open menu answers the safety question exactly and needs no reading at all.

**Read the platform once at module load.** Rejected: the reading would be fixed for the process, and a test could only vary it by resetting the module. Reading it per gesture costs one property access on a click.

**Detect the Apple host through `navigator.userAgentData`.** Rejected: the TypeScript DOM library this repo compiles against does not declare it and Safari — the browser whose Ctrl+click dispatches the extra `click` — does not implement it, so the cast would buy nothing. `navigator.platform` is deprecated and universally answered, and the modifier convention is the use MDN still documents it for.

**Take the additive modifier as Cmd-or-Ctrl everywhere and let the row menu win.** Rejected: both gestures still run on WebKit, so the range keeps a toggle the operator never asked for, and the row under a right-click is left selected or deselected at random.

**Give the search results `tabIndex={0}` rows, as they had.** Rejected: it is the same fifty-tab-stop sidebar the roving seat exists to remove, and a list that declares `role="tree"` and answers no arrow key is worse than one that declares nothing.

**Keep the native `disabled` and skip inert rows in the arrow ring.** Rejected: the operator cannot then discover that the row exists or why it is unavailable, which is the whole reason the pattern keeps it focusable.

**Keep `aria-expanded` on the overflow row after promoting it to a tree row.** Rejected: it read correctly on a plain disclosure button and stops reading correctly on a `treeitem`, where it announces child nodes and an expand key that the row has neither of.

**Leave the overflow row a button and take it out of the tab order.** Rejected: `tabIndex={-1}` on a control nothing else reaches makes it keyboard-unreachable, which is worse than a stray tab stop. It is a row of the list by position and by verb, so it is a row of the account too.

**Match the type-ahead against the row's rendered text.** Rejected: a row's text is its title plus its status and relative time, so a search would answer to "3" and to the word "running" as readily as to a session's name. The label the row publishes is the one string an operator is looking for.

**Clear the focus reading on any `focusout` with no relatedTarget.** Rejected: that is the shape a removed row's blur takes in a browser, so the clear would fire in exactly the case the recovery is for. Whether the blurred element is still connected separates the two, and the reading survives the removal it has to survive.

## Consequences

An Apple host's Ctrl+click opens the row menu at the cursor and does nothing else, and Cmd+click edits the range; every other host keeps Ctrl for the range and its own secondary button for the menu. The search results cost one Tab and answer the arrows. Menu rows a range cannot reach are announced and refused rather than hidden from the keyboard, which changes what `hasAttribute('disabled')` reports for every `Menu` caller — the two callers that asserted it now assert `aria-disabled`. A folded group's overflow row costs no tab stop of its own and answers the arrows, which changes its role from `button` to `treeitem` for anything querying it. A row list of any length is reachable by typing its rows' names. A focus the operator moved out of a row list stays where they put it.

Coverage: `tests/pointer-platform.client.spec.ts` pins both readings on an Apple host, an iPad, and a Windows host; `tests/rows.client.spec.tsx` pins the Apple Ctrl+click end to end — the list opens at the cursor, the focus stays on the row, the companion click edits nothing, and Cmd toggles once the list is gone — and pins that a click under any open row menu dismisses it rather than acting on the row, and pins the search row's seat, level, keys, and its `aria-current`-without-`aria-selected` state, and pins select-all taking the account, refusing a row outside it, and taking the browser's own select-all away with it; `tests/browser-styles.client.spec.ts` pins that every row the seat can land on draws its ring inside itself, which the list's two-axis clipping requires; `tests/workspace-browser.client.spec.tsx` pins one tab stop across a rendered result list, the arrow that moves it, a type-ahead walking an assembled tree, a select-all archiving every reachable Session from the keyboard alone in both the grouped and the flat list, and counting a Session once where an expanded project puts both the header answering for it and its own row in the account, the overflow row's seat, its absent `aria-expanded`, and its single activation, and an accessibility audit of the assembled region in both the grouped and the search state — the audit the row-level one could not stand in for; `tests/row-focus.client.spec.tsx` pins the recovery when the seated row leaves, the recovery of a focus on a row the seat never moved to, the refusal to reclaim a focus that moved out of the list or that the operator dropped on purpose, and the type-ahead's landing, its repeat walk, its refinement, its window, and the miss that holds; and `packages/client/ui-primitives/tests/atoms.client.spec.tsx` pins the inert row's focusability, its refusal, the submenu it does not open, and the arrow ring that now includes it.
