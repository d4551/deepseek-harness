# Agent Note: Stop the UI gates certifying their own holes

Status: implemented

English | [中文](2026-08-31-ui-gates-stop-certifying-their-own-holes.zh.md)

## Problem

Three gates passed a clean tree while missing most of what they claim to reject, and a fourth defect shipped a contrast regression under cover of a token that had never resolved.

The reduced-motion check in `scripts/client-ui-ssot.ts` asked whether a sheet mentioned `prefers-reduced-motion` anywhere and whether *any* rule inside it stopped *any* animation. Six probes passed it that should have failed: two animated selectors with one guard, a guard written outside the media block, the `animation-iteration-count: infinite` longhand, a guard naming a different selector, a guard placed before the rule it was meant to override, and a media block that opened and only restyled a colour. The regex `@media[^{]*prefers-reduced-motion[^{]*\{[\s\S]*$` ran to end of file, so any later `animation: none` in the sheet counted.

The i18n check in `scripts/verify-client-ui-i18n.ts` found painted copy only by tracing a parameter of a `function` declaration into `textContent` or `innerText`. It missed `el.textContent = 'literal'` — the plainest form — along with `innerHTML`, `insertAdjacentText`, `createTextNode`, `append`, `setAttribute('aria-label', …)`, `placeholder`/`title` assignment, arrow and method sinks, and every parameter but the last (`sinks.set(name, index)` overwrote). Its file list reached `packages/client/*` plus packages that happened to contain a `.tsx` under `src/client`, leaving 67 files unscanned, among them a pre-boot chooser painting eight untranslated strings through `innerHTML`.

`--dsw-alias-label-error` had been added pointing at `--dsw-alias-state-error-primary`. That rung is `red-600` in light (4.4976:1 on white) and `red-400` in dark (4.24:1 on `bg-layer-2`, 3.68:1 on `bg-layer-3`) — under the WCAG 1.4.3 minimum in all three. Before the token existed the `var()` did not resolve, the declaration dropped, and the copy inherited `label-primary` at 11.57:1 in dark. Defining it made shipped error text worse. `--dsw-alias-fill-l2` had the same origin: its dark value `bluish-800` is exactly `--dsw-alias-bg-layer-3`, which is the menu the chip sits on, so the chip was 1.00:1 against its own background.

`zod` 4.5.4 resolves a schema reference chain transitively the first time it parses through one. The generated recursive generic built a fresh instantiation per dereference, so `Self<T>` referencing `Self<T>` was an endless tower rather than a cycle, and parsing overflowed the stack.

## Decision

**A guard answers a selector, not a sheet, and only for the readers who asked.** `cssRules` brace-matches the stylesheet, descending at-rules, skipping `@keyframes` frames, and recording whether an enclosing `@media` asks for less motion. Every selector declaring an unending animation must be named by a stopping rule that sits *after* it, or by `*`. Shorthand and longhand infinite forms are both detected, and a finite iteration count, `animation: none`, `animation-play-state: paused`, and a duration of at most a millisecond all count as stops. Four things the feature name alone got wrong: `not (prefers-reduced-motion: reduce)` inverts the query and credits a guard to the readers who did not ask, so any negation disqualifies a prelude; `(prefers-reduced-motion: no-preference)` is the opposite query and credits a guard to the readers who did not ask for it; a brace inside a string is not a block, and counting it shifts every later rule into the wrong one; and whitespace around a combinator is not part of a selector's identity.

**Copy that never touches a sink is still copy.** A literal put into component state is painted wherever that state renders, which no assignment rule can see. Both ends of the pair count — the `useState` seed as much as the setter — and the setter is found through the pair's own destructuring rather than by guessing a naming convention. State also holds keys and ids, so a lone token is read by shape: an inner capital, a separator, or a digit is how `ArrowRight` and `plugin-card-open` are written and how `Saved` is not. Requiring a space instead would have excused every one-word label the attribute rules already reject.

**The sink is the assignment, not the helper.** Copy is reported where it is painted: a literal on the right of any `TEXT_SINK_PROPERTIES` assignment, an argument to `insertAdjacentText`/`createTextNode`/`append` and friends, and the value of `setAttribute` for a copy-bearing attribute. Parameter tracing remains for helpers, now reading declarations, methods, and named arrows, keeping every painted position, and matching calls made through a receiver. The file list is every `packages/*/*/src/client` tree.

**Markup is structure, not copy.** A template that interpolates its copy is left holding only tags, and tag names are not copy. `markupText` drops tag syntax while keeping the text between tags and the values of `aria-label`, `title`, `alt`, `placeholder` and their ARIA siblings — matched with a left boundary, so `data-title` is not one of them — single-quoted as readily as double-quoted — a template is written in backticks, so both are idiomatic inside one. Inline copy is still rejected while a pure-structure template is not.

**Diagnostics are listed literally.** `NON_COPY_DIAGNOSTICS` names three exact (file, text) pairs: a realm label identifying a browsing context to a developer tool, a stand-in for a console argument that would not serialize, and the render-failure line the Host keeps for the model. The last is pinned verbatim by the model-facing-contract rule, so translating it would break what that rule protects. Keying on exact text means any other string in those files still fails.

**One observation, two outlets, two shapes.** That render-failure line was also being painted: the panel put a translated label in front of it and appended the whole English sentence, inside `role="alert"`. `DynamicCordisRenderFailureView` adds `cause` — the crash text and any redirect, without the English framing — for the page-local outlet, while the wire record keeps `message` verbatim for the model. The panel renders `cause`, so the exempted text is no longer shown to anyone.

**Error copy gets its own rung.** `red-700` (light, 6.03:1 on white) and `red-300` (dark, 4.51:1 on the lightest surface rung a consumer uses, 6.55:1 and 5.68:1 on the two it actually renders on) are new palette entries. `state-error-primary` keeps `red-400` for borders and fills, which answer to the 3:1 non-text minimum. Dark `fill-l2` moves to `bluish-750`, one rung off the menu instead of equal to it: 1.26:1 separation against the surface, where the light pair separates at 1.16:1, and `label-secondary` on it at 6.37:1.

**One instantiation is one schema.** `SchemaEmitter` emits generic declarations through a generated memo keyed on the argument schemas, so a self-reference resolves to the instantiation already being built. The memo is written after construction because a self-reference is reached only through `z.lazy`, which does not run while the definition is built. Identity is only stable if the argument is: a self-reference that writes its argument out (`Self<string>` inside `Self<T>`) evaluated that expression again on every dereference and missed the memo entirely, so an argument that reads no type parameter is emitted once as a module binding and referred to by name. Every generated binding — schema, parameter, hoisted argument — is allocated from one identifier set, because a declaration may legitimately be called `argument0` or `type0` and was otherwise given the same name twice or silently shadowed inside the factory. What no memo can close is a self-reference built *from* its own parameter (`Grow<V>` whose member is `Grow<V[]>`): it names a different type at every level, so the generator refuses it instead of emitting a schema that overflows at parse.

**One workspace version per dependency.** `checkSingleExternalVersion` holds every workspace manifest to one base version of each external dependency, comparing base versions so an exact pin and a caret on the same version are one choice. `vendor/` is exempt: those manifests are pinned copies of upstream and move only through the vendor sync procedure.

## Consequences

The reduced-motion rule now fails all six probes it used to pass and still accepts correct sheets, `@keyframes` frames, comma-separated selector lists that are fully answered, and `*` guards. The i18n rule catches fourteen sink forms, ignores `data-*` attributes and form values, and covers 621 files. Multi-process suites take their timeout from the file rather than from whichever cases remembered to ask: `install-lefthook` had twenty-two spawning cases on the lane's 30s default, which is what made the suite intermittently red. The pre-boot preview chooser owns an `en`/`zh` dictionary; it resolves the browser preference itself rather than importing a resolver across a package edge that this independently bundled prototype deliberately does not have.

Two comments that stated false things were corrected: `label-quaternary` claimed one consumer where there were two, the second an enabled link whose underline is now `currentColor`; `StatsLine.module.css` recorded 1.1:1 where the value is 1.25:1 light and 1.41:1 dark.

Extending the object-literal copy rule to `.ts` files was tried and reverted: it surfaces 228 candidates dominated by model-facing catalog `description` fields, which are not reader copy. That needs its own scoped pass rather than a blanket flip.

`website/` stays on `vite ^5.4.14` because VitePress 1.6.4 is the current release and depends on that range; the workspace-version rule covers `packages/*` and `apps/*` and does not reach it. VitePress's client entry imports `vitepress-plugin-mermaid/Mermaid.vue` by bare specifier, which an isolated install cannot resolve from VitePress's own directory, so the site config aliases it to the copy the site installed.

## Alternatives considered

**Keep the reduced-motion rule a regex and widen the pattern.** Rejected: the six holes were not one pattern each. Ordering, selector identity, and block membership are structure, and a pattern that cannot see a brace cannot see any of them.

**Exempt the whole file for the three diagnostic strings.** Rejected: `runtime.ts` is over a thousand lines, and a file-level exemption would swallow real copy added to it later. Listing the exact text costs three entries and cannot widen on its own.

**Point `--dsw-alias-label-error` at `label-primary`.** It would clear the contrast minimum, but error copy would stop being red, which is the state the token exists to signal. A new rung in the same ramp keeps the signal and the minimum.

**Pin `zod` back to 4.4.3.** The overflow arrived with 4.5.4, and reverting would have hidden a generated-code defect rather than fixed one: an instantiation that is not shared is wrong independently of which version notices.

**Alias the whole `vitepress-plugin-mermaid` package rather than the one component.** The failing import is a single specifier from VitePress's own entry; aliasing the package root would also redirect the config's own import, which already resolves.
