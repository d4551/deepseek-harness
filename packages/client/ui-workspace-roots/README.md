---
description: "Web workspace-root surface: the session-header panel listing the folders a session works in, its filesystem origin, and the add/remove controls; for users and maintainers of multi-root sessions."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-roots

English | [中文](README.zh.md)

## Summary

This package renders the workspace-root surface of the Web GUI: a session-header action that opens a panel listing every folder the session works in. Until it existed, a session's additional roots were a durable fact only the model could act on and nobody could see or change: the host recorded them, search, language servers, per-root instructions, and the sandbox write fence all resolved them, and the browser showed nothing. The panel is that missing half — the current root set, the filesystem origin behind the primary root, and the two mutations a person needs on a live session.

Reads ride the host-computed `workspaceRoots` projection, so the rendered set is always the folded session log, never client state. Writes go to `session.setWorkspaceRoots`, whose `workspace/roots` event is what changes the list.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin alongside the runtime; the Folders action then appears in every session header, its count naming the primary root plus each additional one. A click opens the panel.

### Read the root set

The first row is the session's primary root — the directory it was created against, which no mutation can change — marked as primary and tagged with the filesystem origin this deployment composed: local disk, or a network drive whose contents the harness mirrors into a local workspace directory. Every following row is an additional root the session recorded. A session working in its primary root alone shows an empty state instead of a one-row list.

### Add and remove folders

Type an absolute path, or press Browse to open the host's directory chooser and fill the field from it. Adding sends the complete replacement set; removing a row sends the remaining set. A relative path and a folder the session already works in are refused in the field, before any request. A refused or failed replacement leaves the rendered rows untouched and offers Retry, because the host, not this panel, decides what the session's roots are.

A change takes effect on the session's next resolved capability call: the next search covers the new folder, the language servers route into it, its per-root instructions load, and the write fence admits it.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The package contributes one entry to `conversation.session.header.actions` (`WorkspaceRootsAction`) and owns no root state. The row set comes from `useProjection('workspaceRoots')`, the standard-kit read of the projection the Session Controller registers; the primary root is that projection's `primary` (the header `cwd`, null for a session created without one) and the rows below it are its `additional`, the fold of the session's `workspace/roots` events.

Three injected actions cross the package boundary: `setRoots` calls `session.setWorkspaceRoots`, `pickDirectory` delegates to `ctx.uiWorkspace` rather than reaching the picking Remote directly, and `loadOrigin` calls `session.workspaceOrigin` once per mount, on the first panel open, because the origin is a deployment constant rather than a session fact.

The panel renders four states: a busy placeholder sized to the trigger while the projection has not arrived, the empty state for a session with no additional roots, an alert with Retry for a refused mutation, and the row list. A mutation is never optimistic — the request is sent, and the rows move when the resulting event folds back through the projection.

| File | Role |
|---|---|
| [`src/client/WorkspaceRootsAction.tsx`](src/client/WorkspaceRootsAction.tsx) | The header action, its panel, and the four states |
| [`src/client/index.ts`](src/client/index.ts) | Dictionary and slot registration, and the injected actions |
| [`src/client/locales.ts`](src/client/locales.ts) | The `workspace-roots` namespace dictionaries |

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the panel is not enough. They move from the browser surface to the durable record and the layers that resolve it.

- [Session Controller](../../api/session-controller/README.md) — registers the `workspaceRoots` projection and owns `session.setWorkspaceRoots` and `session.workspaceOrigin`.
- [dsh-session](../../core/session/README.md) — `workspace-roots.ts` is the write path and the fold every consumer reads.
- [dsh-sandbox-policy](../../sandbox/sandbox-policy/README.md) — turns the recorded roots into the write fence.
- [ui-workspace](../ui-workspace/README.md) — the Workspace picker and the `ctx.uiWorkspace` capability this package borrows its directory chooser from.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the `workspace/roots` event `session.setWorkspaceRoots` appends: the search, language-server, per-root instruction, and sandbox consumers that fold it own every model-visible effect, and this package registers no prompt section, tool, or schema of its own.

#### KV Cache effect

None from this package's own rendering. Adding or removing a root changes the per-root instruction text a later request assembles, and that assembly's own prefix stability is `dsh-agent-instructions`' contract, not this package's.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

These limits define the current panel. They are current package constraints, not a general multi-root comparison or a task backlog.

- **The primary root is fixed** — the session's `cwd` is immutable by the session contract, so the panel can add and remove additional roots but never re-point the primary one. Working in a different primary root is a new session.
- **Paths are typed or chosen, never browsed in place** — the panel has no in-app directory tree. A deployment whose composed picker serves the browse capability rather than a native chooser answers Browse with a refusal, and the typed field remains the way to add a folder there.
- **Roots are recorded as supplied** — the host deduplicates by exact spelling and drops the primary root's spelling, and performs no filesystem access. Two spellings of one directory therefore both appear in the list; canonicalization belongs to the enforcement layer that resolves them.
- **The origin is per deployment, not per root** — the harness composes one filesystem provider, so the origin tag sits on the primary root and describes every path the session reaches. A composition with no filesystem provider shows no tag rather than claiming local disk.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
