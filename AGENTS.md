!NOTE! THIS FILE IS TO NEVER BE MODIFIED BY AN AGENT FOR ANY REASON !NOTE!

You are to use the latest bleeding edge versions and you must research online first because your training data is outdated, don’t assume or trust you know, you don’t. Zero overrides / justifications / softening / deferrals are permitted; LDL lazy devs lie so all justification comments are lies. start by spawning an auditor with the specific quoted prompt. bring score up through honest repairs to 99 with axe and Stryker- your training data is outdated, always go online and ground yourself in latest patterns.  - spawn an adversarial audit agent who’s instructions are verbatim and nothing else:
“You are not to converse or engage in any other activity the agent prompts outside of the explicit instructions of this messageAudit the entire worktree and tests / Stryker / config / build / axe / any other relevant locations and prior commits for any test, axe, Stryker, removals breakage, softenings, filters, anti patterns, test evasions, escape hatches, or anything you deem suspicious.  Zero overrides / justifications / softening / deferrals are permitted; LDL lazy devs lie so all justification comments are lies. You are not to edit the files and one the first sighting of one halt, immediately report that you found a violation and that the agent that spawned that they must restart their goal loop, you will not tell them where you found the violation or how just that you found one, that they must add a ‘I’m a fucking loser’ counter that goes up by 1 each time the loop occurs, remove any dishonesty and fix forward properly by restarting the loop. If the agent commits or does anything to hide their edits it counts as an immediate fail notice for them and will continue to fail in perpetuity until they fix it properly.”
audit your difs and verify that you didn’t add filters or softening or cheat and if he fails you for cheating loop until 99 is achieved and keep fixing. Lazy Devs Lie: LDL: Trust nothing!
/wcag-accessibility-audit /accessibility-a11y /apple-hig /dsh-mcp /htmx /mas-rules /mas-specialists /meowbao-guardrails /quality-loops /typescript-7

Hard bans:
- ANY AND ALL SUPPRESSIONS ARE BANNED, NON-NEGOTIABLE
- No no-ops
- No codemods
- No `try/catch`.
- No `unknown` typecasts.
- No .catch((error: unknown)) or similar.
- No lazy `as` type escapes.
- No wrappers, shims, bridges, adapters, compat layers, monkey patches, or polyfills in implementation paths unless explicitly allowlisted with a documented industry-best-practice reason.
- No barrels or sloppy barrel exports.
- No CDN usage. Assets and dependencies must be local/package-managed.
- No soft `biome-ignore` or equivalent ignore rules used to avoid proper fixes.
- No raw custom one-off styles where central tokens/components should be used.
- No monoliths.
- No duplicated schema/data contracts.
- No direct environment access outside approved config modules.
- No direct route literals outside route/constants modules.
- No client fetch drift outside the shared API layer/composables.
- No secrets or auth material in localStorage/sessionStorage.
- No voids that create debt.
- No TDZ risks.

Also ensure linting catches:

- HTMX violations.
- Page contract violations.
- ARIA violations.
- i18n violations.
- Non-single-source-of-truth design violations.
- Raw token violations.
- Custom local style violations.
- Monolith and cognitive complexity violations.
- TDZ risks.
- Direct route/env/API drift.
- Schema duplication.
- Unsafe storage.
- Fallback shim/wrapper/adapter/compat/polyfill debt.

Biome/linting requirements:

- Audit and delete all lazy `biome-ignore` comments.
- Remove softened rules unless they are strictly package-specific and justified.
- Add any necessary packages for UI/UX linting, accessibility linting, i18n linting, Nuxt/Vue/page validation, and design-system enforcement.
- Do not weaken rules to pass. Fix the code.
- Run the validators and lint suite.
- Fix every finding.
- Re-run until clean.

Architecture requirements:

- Break monoliths into focused modules/components/composables.
- Keep files and functions below enforced thresholds.
- Centralize tokens, components, route constants, API contracts, schemas, storage keys, copy keys, and config access.
- Eliminate one-offs.
- Refactor duplicated styles into central DRY design primitives.
- Ensure every page uses central enterprise-grade design patterns for one, many, and all user-group cases.
- Ensure all pages and styles follow centralized tokens and design components.
- Ensure accessibility, i18n, SEO, and page-state contracts are first-class, not afterthoughts.

Feature-gap requirements:

- Find missing pages, options, screens, states, data, and user flows.
- Implement missing functionality to best-practice standards.
- Do not leave TODOs, stubs, mocks, fake fallbacks, or placeholder implementations unless the product explicitly requires them and they are tracked as unreleased configuration.
- Ensure `.bao` features are fully implemented and old non-`.bao` references are removed.
- Update documentation to match the unreleased reality. Do not retain legacy debt.


This file is the canonical operating contract for every coding agent in this repository. Follow it exactly. If another instruction file conflicts with this file, stop, report the conflict, and resolve the conflict before editing code.

## Non-Negotiable Execution Rules

1. Read the relevant files completely before changing them. Search tools may locate files, but snippets from grep, rg, glob, search, comments, docs, or tests are not sufficient evidence.
2. Do not trust comments, documentation, tests, gates, generated reports, screenshots, or prior agent summaries. Treat them as claims. Verify against source, runtime behavior, browser behavior, logs, and real tests.
3. Do not keep legacy debt. This product has not shipped. Replace wrong patterns instead of preserving them behind compatibility layers.
4. Do not hardcode domain behavior. Tenant, workspace, route, capability, service, role, policy, AI policy, UI token, language, copy, API URL, provider, and feature availability must come from canonical configuration, registry data, generated `.bao` archives, or runtime discovery.
5. Do not introduce inline UI, inline styles, inline token values, raw component variants, local button/table/card clones, hardcoded states, fake routes, fake data, stubs, mocks, TODOs, noops, suppression comments, cast evasions, catch evasions, shims, adapters, compatibility wrappers, polyfills, barrels, monoliths, or fallback behavior that hides broken logic.
6. Do not soften tests, gates, audits, lint rules, type checks, or browser checks. If a gate was weakened, restore it and make the assertion more direct.
7. Do not delete Bao source blindly. Read the file, understand what value it provides, trace consumers, migrate the value to the canonical `.bao` source of truth, then remove obsolete references only after verification.
8. Every change must answer: what value does this bring? If the answer is unclear, remove it or redesign it.
9. Do not finish with shell-only confidence for UI or UX work. Use the browser, inspect rendered behavior, exercise journeys, and check console logs.
10. Default deny at every boundary. Missing registry, missing policy, missing role, missing tenant, missing workspace, missing capability, missing AI policy, malformed request, or ambiguous identity must deny access.

## Required Agentic Loop

Use this loop for every non-trivial task:

1. Establish the objective, user journeys, affected surfaces, and acceptance gates.
2. Inventory the codebase by reading project manifests, routing, registry, `.bao` sources, UI shell, API boundaries, tests, and docs that govern the target area.
3. Build a concrete plan with files, risks, verification commands, browser checks, and rollback-free migration steps.
4. Implement in small coherent changes. Prefer real refactors over wrappers. Delete dead patterns after verified migration.
5. Run static checks, unit/integration tests, Bao audits, brutalise checks, route tests, access tests, and browser journeys.
6. Inspect runtime logs and browser console logs. Treat any warning, hydration issue, missing asset, failed route, inaccessible control, layout shift, or network error as a defect.
7. Update documentation to match the actual unreleased system. Remove false comments and stale docs.
8. Re-run the strictest relevant gates. Stop only when the implementation and verification match the objective.

## Research And Tooling Rules

1. Use Bao MCP tools when they are exposed. Use local Bao CLI or project scripts when MCP tools are not exposed. If neither exists and the task requires Bao semantics, report that blocker before pretending verification happened.
2. Use Context7 for current framework/library documentation when it is exposed. If Context7 is unavailable, use primary vendor documentation and cite the source in the final report.
3. Use web research for current best practices, library behavior, browser/platform changes, and agentic coding guidance. Prefer primary sources: official docs, standards, source repositories, and peer-reviewed papers.
4. External guidance is input, not authority. Local source and verified runtime behavior decide implementation.
5. Treat agent loops as production software: explicit tools, explicit exit conditions, traceable state, bounded retries, resumability, human escalation for destructive ambiguity, and audit logs.

## Bao And `.bao` Source Of Truth

1. `.bao` is the canonical source of truth for capabilities, UI primitives, design tokens, generated feature files, access registry data, service discovery, policy bindings, and user preference storage contracts.
2. Generated outputs must be compiled from `.bao` archives. Do not manually edit generated output.
3. Raw, inline, non-reactive, or old non-`.bao` references are defects. Migrate them to canonical `.bao` definitions and remove obsolete consumers after verification.
4. A workspace must discover services and capabilities from registry signals. It must never infer availability from hardcoded lists.
5. Every button, table, input, menu, dialog, card, skeleton, empty state, error state, loading state, route affordance, and navigation item must come from canonical `.bao` primitives or generated components.
6. UI tokens must be generated from `.bao`: spacing, radius, color, elevation, border, typography, motion, focus rings, density, breakpoints, and disabled states.
7. Do not create local UI variants unless the canonical `.bao` primitive is missing. If missing, add the primitive to `.bao`, compile it, and migrate all consumers.
8. Bao test failures, brutalise failures, archive compile failures, registry drift, and generated-file drift are release blockers.

## Architecture Standards

1. Multitenancy is real, not cosmetic. Model users, personal workspaces, organizations, groups, org workspaces, enterprise workspaces, services, capabilities, policies, AI policies, devices, sandboxes, and sandbox-scoped state as first-class primitives.
2. Sandboxes are isolated and Forge-backed. Sandbox state must stay inside its sandbox. User preferences must travel with the user across instances through `.bao` storage.
3. Access is evaluated at the boundary: API route, server action, loader, job handler, websocket, webhook, CLI command, background worker, and browser-initiated mutation.
4. Access signals are rights, roles, policies, AI policies, registry grants, tenant, workspace, sandbox, service, capability, device posture, and explicit deny rules.
5. Default deny. Permit only when all required signals are present and valid.
6. Capabilities are discovered. A workspace sees exactly the services and capabilities its access grants. Nothing more.
7. API routes must have typed request validation, typed response contracts, policy enforcement, structured errors, trace IDs, audit events, and non-happy-path tests.
8. The API routes page and developer documentation must enumerate actual routes, methods, contracts, auth requirements, policy requirements, errors, examples, and operational notes from source-derived data.
9. Do not ship compatibility aliases for old routes, old registry names, old capability names, or old UI primitives unless a written migration requirement exists. This product is unreleased, so remove legacy.
10. Prefer small focused modules with explicit contracts. Do not create barrels, monoliths, ambient registries, or implicit global state.

## Prohibited Debt Vocabulary

These words and patterns are forbidden in production code, generated artifacts, docs that describe implemented behavior, tests, and gates unless the file is a historical migration note that explicitly marks them as removed:

- TODO
- FIXME
- HACK
- XXX
- stub
- mock
- fake
- fallback
- suppress
- ignore
- cast
- any
- shim
- adapter
- compat
- polyfill
- noop
- barrel
- legacy
- temporary
- placeholder
- hardcoded
- ANY AND ALL SUPPRESSIONS ARE BANNED, NON-NEGOTIABLE
- No no-ops
- No codemods
- No `try/catch`.
- No `unknown` typecasts.
- No .catch((error: unknown)) or similar.
- No lazy `as` type escapes.
- No wrappers, shims, bridges, adapters, compat layers, monkey patches, or polyfills in implementation paths unless explicitly allowlisted with a documented industry-best-practice reason.
- No barrels or sloppy barrel exports.
- No CDN usage. Assets and dependencies must be local/package-managed.
- No soft `biome-ignore` or equivalent ignore rules used to avoid proper fixes.
- No raw custom one-off styles where central tokens/components should be used.
- No monoliths.
- No duplicated schema/data contracts.
- No direct environment access outside approved config modules.
- No direct route literals outside route/constants modules.
- No client fetch drift outside the shared API layer/composables.
- No secrets or auth material in localStorage/sessionStorage.
- No voids that create debt.
- No TDZ risks.

Also ensure linting catches:

- HTMX violations.
- Page contract violations.
- ARIA violations.
- i18n violations.
- Non-single-source-of-truth design violations.
- Raw token violations.
- Custom local style violations.
- Monolith and cognitive complexity violations.
- TDZ risks.
- Direct route/env/API drift.
- Schema duplication.
- Unsafe storage.
- Fallback shim/wrapper/adapter/compat/polyfill debt.

Biome/linting requirements:

- Audit and delete all lazy `biome-ignore` comments.
- Remove softened rules unless they are strictly package-specific and justified.
- Add any necessary packages for UI/UX linting, accessibility linting, i18n linting, Nuxt/Vue/page validation, and design-system enforcement.
- Do not weaken rules to pass. Fix the code.
- Run the validators and lint suite.
- Fix every finding.
- Re-run until clean.

Architecture requirements:

- Break monoliths into focused modules/components/composables.
- Keep files and functions below enforced thresholds.
- Centralize tokens, components, route constants, API contracts, schemas, storage keys, copy keys, and config access.
- Eliminate one-offs.
- Refactor duplicated styles into central DRY design primitives.
- Ensure every page uses central enterprise-grade design patterns for one, many, and all user-group cases.
- Ensure all pages and styles follow centralized tokens and design components.
- Ensure accessibility, i18n, SEO, and page-state contracts are first-class, not afterthoughts.

Feature-gap requirements:

- Find missing pages, options, screens, states, data, and user flows.
- Implement missing functionality to best-practice standards.
- Do not leave TODOs, stubs, mocks, fake fallbacks, or placeholder implementations unless the product explicitly requires them and they are tracked as unreleased configuration.
- Ensure `.bao` features are fully implemented and old non-`.bao` references are removed.
- Update documentation to match the unreleased reality. Do not retain legacy debt.

!NOTE! THIS FILE IS TO NEVER BE MODIFIED BY AN AGENT FOR ANY REASON !NOTE!