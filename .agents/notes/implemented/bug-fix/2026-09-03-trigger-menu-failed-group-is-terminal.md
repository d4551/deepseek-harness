# Agent Note: A dropped menu group is a failure the user never sees and the client never stops retrying

Status: implemented

English | [中文](2026-09-03-trigger-menu-failed-group-is-terminal.zh.md)

## Problem

Typing `/` in the Web composer against a host whose `commands/list` answers an application error produced a menu with group titles and no bodies, no error anywhere in the DOM, and 118 identical failing requests from one keystroke session. The host answer was precise and actionable:

```
POST /api/commands/list → 200
{"result":{"ok":false,"error":{"code":"internal","message":
"resume failed for session \"session-d5b2600d-…\": Error: agent-presets: preset \"meowbao\" failed to mount:
failed to import loader entry tool-bash (@deepseek-ai/dsh-tool-bash): Cannot find package '@deepseek-ai/dsh-tool-bash'"}}}
```

Three separate defects turned that answer into a blank menu.

**The message had nowhere to go.** `MenuState.groups[].status` was `'pending' | 'ready'` — the vocabulary had no failed state and no field for a message. `menuReduce`'s `source-failed` case *removed* the group, and `InputTriggerController.fetchCandidates` discarded the rejection into `console.error`. The `role="alert"` branch that does exist, in `ui-commands`' `PopupSelectView`, belongs to a different component: that shell renders a registered contribution's option picker (`/model`, `/permission`), and a catalog-list failure never opens it. No component on the `/` path could render the failure.

**Removing the group made the failure self-repeating.** The web profile runs two `/` sources. With `command` removed and `skill` settled empty, `allReadyEmpty` held and the reducer auto-closed the menu. `InputTriggerController.track` treats an unchanged hit as a no-op only while `prev.open` — so on a closed menu every later draft or caret notification re-seeded the roster and re-fetched every source. The composer emits many such notifications per keystroke, and each one cost another `commands/list`. Between them the transient states were two pending groups, which is the titled, bodiless menu the user saw: the render never settled because the pipeline kept restarting it.

**Neither transient state had accessible text.** The pending block carried an `aria-label` on a `role="status"` wrapper around two decorative skeleton bars and no text node; the failed state had no element at all. `read_page` over the open menu returned no listbox, no options, and no alert.

## Decision

A source failure is a state the menu holds, not a group it drops.

`MenuGroup` is a three-arm discriminated union — `pending`, `ready`, and `failed` carrying `error: string`. `source-failed` gains that message and rewrites the group in place; the group keeps its roster seat and its title. A new `source-removed` event carries the old silent-drop behavior, which now has exactly one producer: `InputTriggerController.sourceRemoved`, raised when a source unregisters. Confusing the two is what made an unmountable preset look like an uninstalled plugin.

A failed group is never `ready`, so `allReadyEmpty` is false and the menu stays open on its own. That is the whole loop fix: an open menu makes `track` short-circuit an unchanged hit, so the 118 requests become one. Nothing else changed in the fetch path, and no debounce or delay was added — the request count falls because the state settles.

`MenuView` renders a failed group as a `role="alert"` block outside the listbox (a listbox may hold only options), carrying the localized `error.title` with the group's own localized name substituted, the host message verbatim, and a Retry button. `retrySource` is the only path in the pipeline that repeats a load it already gave up on: it flips one failed group back to `pending` through `source-retry` and re-runs that source alone, leaving a sibling still in flight untouched. It rides the open round's `AbortController`, so closing the menu or typing another character drops a retry exactly like the fetch it replaces.

`CommandDirectory` is unchanged. Its documented "cold or failed launches a fresh pull" is what makes Retry, a new query, `commands/change`, `agent-preset/selected`, and `connection/reset` all recover without a second retry vocabulary across the seam.

Both transient states now carry text. The failed alert's message is visible content. The pending block keeps its `aria-label` and adds a visually hidden copy of the same string, because a tool that reads text nodes surfaces nothing from an `aria-label` over decorative bars.

Copy is locale-owned: `slash.menu` gains `error.title` and `retry` in `zh` and `en`. The host message is not copy — it is the server's own diagnostic, rendered as data beside the localized frame, which is the point of showing it.

## Alternatives considered

**Debounce or rate-limit the candidate fetch.** It would hide the request count and leave the menu blank, because the group is still removed and the menu still closes. The defect is that a failure has no resting state, not that requests arrive too quickly.

**Make `CommandDirectory.ensureReady` reject a failed key without re-pulling.** This is the deeper terminal state and drops a failing catalog to one request per *session*, not one per hit. It was rejected because it strands the recovery paths: `matchEnter` would refuse forever on a host that came back, and Retry would need a `retry` flag threaded through `CandidateRequest` and every source to bust the cache it just made permanent. The menu-level fix already bounds the loop to user intent, and the directory's existing invalidation events remain the honest recovery signal.

**Keep the group removal and surface the failure as a composer notice.** The notice channel is the input machine's, it is not tied to the menu's lifetime, and it cannot host a Retry that knows which source failed. It would also leave the menu auto-closing, so the loop would survive.

**Show the failure in `PopupSelectView` instead.** That shell already has an error strip with a retry button, which is why the defect report pointed at it. It is the wrong component: it renders a registered contribution's options after the menu has been dismissed, and a catalog-list failure happens before any pick. Its error branch stays where it is, for an options load or an `onSelect` that fails.

**Render an explicit empty row for a settled group with no rows.** The menu deliberately shows nothing for one empty group and closes when every group is empty, so the composer is not covered by a box that has nothing to offer. That behavior is unchanged; a failed sibling now holds the menu open around it.

## Consequences

A failing `/` source is visible, quiet, and recoverable: the group names itself, shows the host's message, and offers one Retry. The request count for the reported session drops from 118+ to one, and to one more per Retry press or changed query.

The menu no longer closes when its last source fails. A user who types `/` against a fully broken host now gets a box with an error in it rather than nothing — which is the intent, and is a visible behavior change for any source that fails routinely.

`MenuEvent` grew two members and `MenuState.groups` became a union. Every reader that already switched on `status === 'ready'` was correct as written; the one that was not — `MenuView`'s listbox filter, which listed the statuses it excluded rather than the one it wanted — would have rendered a titled, empty group inside the listbox for the new status, and now asks for `ready` directly.

`packages/client/ui-commands/tests/menu-load-failure.client.spec.tsx` pins the whole seam against the reported host answer: the real `CommandUiRuntime` source, a real `InputTriggerController`, and the real `MenuView`, with only the Remote and session faces doubled. It asserts the host message reaches the alert, that thirty further draft notifications issue no request, that Retry issues exactly one and renders the recovered rows, and that a healthy catalog is unaffected. Reverting the reducer fails five of its six cases; reverting the view's failed branch fails four of them and five view cases; reverting `retrySource` fails five across both packages.

The four states of a source's group — loading, empty, error, success — are each asserted in `menu-view.client.spec.tsx`, and the same four for the `PopupSelectView` shell in `popup-view.client.spec.tsx`. The failed menu also carries its own axe audit.
