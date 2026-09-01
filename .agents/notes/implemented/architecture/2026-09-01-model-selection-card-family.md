# Agent Note: One model-route contract behind both model-selection cards

Status: implemented

English | [中文](2026-09-01-model-selection-card-family.zh.md)

## Problem

Two Client settings cards edit a provider/model route: the subagent allowlist and the Agent default. When the second one landed it restated everything the first already had — a `{provider, model}` interface, a `${provider}\0${model}` identity function (a third copy built the same string inline), the catalog join that keeps a stored-but-unadvertised route removable, the `'idle' | 'loading' | 'ready' | 'error'` request state, the provider-grouping loop, the candidate row markup, and the loading/failure/partial notices. Each side also restated the settings section its Host package owns, so the stored field set had two homes and could drift without any gate noticing. The duplication hid a defect: the default-model card injected a `retryCatalog` action and never rendered a control for it, so a user whose catalog request failed had no way to reopen it, and the failure copy told them to change a setting or a provider instead.

## Decision

`packages/client/ui-settings-plugins/src/client/model-route.ts` owns `ModelRoute`, `ModelRouteCandidate`, `ModelRouteGroup`, `ModelCatalogStatus`, `modelRouteKey`, `modelRouteCandidates`, and `groupModelRouteCandidates`. `ModelRouteChoices.tsx` renders the fieldset for both cards and takes its selection arity as a discriminated union — `{ mode: 'single', groupName }` binds the radios into one group, `{ mode: 'multiple' }` renders checkboxes. `ModelCatalogStatusNotices.tsx` renders the directory request state, including the retry control both cards now offer. The stylesheet the two cards share is named `model-selection-card.module.css` for the family rather than after one member, and the fieldset's own rules moved to `ModelRouteChoices.module.css`.

Each stored settings section has one declaration, in the Host package that owns it: `@deepseek-ai/dsh-agent-default-model/types` and `@deepseek-ai/dsh-tool-subagent/types` are browser-safe modules re-exported through `@deepseek-ai/dsh-api-remotes/client`, which is how a Client already reads Host vocabulary. The cards bind their scopes to those declarations.

A new `./types` subpath needs both planes: the package export map, and a hand-written `tsconfig.base.json` alias to the same `src` file. `gen-tsconfig-paths` emits only `.` and `/invariant`, and the Typert analyzer resolves through those aliases, so a subpath with an export map and no alias typechecks and then fails `verify-cordis-inspect-catalog` with the export reported missing.

Both stylesheets read the type scale — `font: var(--dsw-font-xxs-12)` and its siblings — rather than repeating the pixel sizes those tokens already name. Spacing and radius stay literal because this design system defines no token for either.

The subagent controller's directory read no longer converts its own `ok: false` result into a thrown `Error` and catches it back: the Remote already folds Host-reported failures into that branch. What the read still absorbs is the one thing that genuinely rejects — an assembly fault — because no page-level handler would catch it and the rest of the Client avoids putting one in the browser console; it now has a test proving the card reports a failed directory rather than one proving only that the fault is swallowed. A duplicate request leaves the in-flight settlement on `background` rather than replacing it with an immediate return.

The card's `currentRoute` trusts the settings type rather than re-checking `null` and `typeof`, matching its sibling, and the settings subscriber no longer reloads an `idle` catalog: the constructor opens the first request synchronously, so the state it guarded on could not occur.

## Testing

`tests/model-route.client.spec.ts` covers the shared join and grouping, and pins the key's injectivity against ids that carry a backslash or a NUL alongside the readable form an ordinary route keeps. Both cards render through `tests/section.client.spec.tsx`, inside the `<main><ul>` containment the plugins tab supplies, and an axe pass over both arities asserts no violations. `tests/model-catalog-stub.client.ts` builds a complete `ModelCatalog` for both card specs, replacing two per-file helpers that reached the Host face through an `as never`.

## Alternatives considered

**Leave the second card's copies in place and add a drift gate.** A gate is the repository's answer when a contract genuinely spans two programs that cannot import each other. These can: `@deepseek-ai/dsh-api-remotes/client` already re-exports Host types for exactly this reason, so a gate would have guarded a duplication that did not need to exist.

**Extract the route list as one card component with a mode flag rather than two cards over one list.** The two cards differ in more than the list — one carries an enable switch and a validation message, the other a conflict notice — so folding them would have produced a component parameterized on which card it is.

**Rely on the NUL separator alone.** A bare `${provider}\0${model}` join is injective only while no id contains a NUL, which nothing enforces. Escaping each id first — backslash doubled, NUL written `\0` — makes the key injective for any pair of strings, leaves an ordinary id byte-identical so `alpha\0fast` still reads as itself, and costs one line. A length-prefixed or JSON encoding would have bought the same guarantee while rewriting every key literal in the specs.

**Share `modelRouteKey` with the Host's identically-named function in `tool-subagent/src/model-selection.ts`.** The two serve different purposes — one is a DOM lookup key, the other a policy equality key — and neither crosses the wire, so coupling the faces would tie a Client rendering detail to a Host implementation choice.

## Consequences

A third card that edits a provider/model route adds a controller and its copy, not another join, grouping loop, or row. The default-model card's catalog failure is recoverable in place, so its failure copy no longer describes a workaround. Adding a field to either settings section is now a single edit in the owning Host package, and a Client that reads a field the Host does not store fails the compiler instead of the user.

`@deepseek-ai/dsh-api-remotes` gained `@deepseek-ai/dsh-agent-default-model` and `@deepseek-ai/dsh-tool-subagent` as peer dependencies, which widens what the Remote assembly's Client face compiles against. Both are type-only re-exports, so nothing new reaches the browser bundle.
