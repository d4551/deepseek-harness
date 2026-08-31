---
description: "Flattening of TypeScript diagnostic message chains into one string, described structurally so either compiler plane can use it without depending on the other."
kind: "package-library"
---

# @deepseek-ai/dsh-diagnostic-text

English | [中文](README.zh.md)

## Summary

`dsh-diagnostic-text` turns a TypeScript diagnostic into the sentence a reader sees. The compiler explains a diagnostic as a nested `messageChain` rather than flat prose, so every surface that prints one has to walk that chain and join it the same way. This package is that walk. It describes the chain structurally — a `text` and an optional `messageChain` — instead of importing the compiler's own `Diagnostic`, so it depends on nothing and both the repository's compiler planes pass their diagnostics straight in.

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

Reach for this wherever a compiler diagnostic becomes text a person reads: a gate's failure output, an analyzer error, a report.

```ts
import { flattenDiagnosticMessage } from '@deepseek-ai/dsh-diagnostic-text'

const message = { text: 'Type A is not assignable to type B', messageChain: [{ text: 'Property x is missing' }] }
const rendered = flattenDiagnosticMessage(message, '\n')
```

A diagnostic that is already a plain string passes through unchanged, so a caller holding `string | Diagnostic` needs no branch of its own.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `DiagnosticMessage` and `flattenDiagnosticMessage` — the whole package |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; chain joining is enforced by unit tests) |

### Why the chain is described structurally

Importing the compiler's `Diagnostic` would tie this package to one compiler entry point and pull a dependency into every consumer. A `text` plus an optional `messageChain` is all the walk reads, and a real diagnostic satisfies that structurally.

### Why an empty chain needs no branch

Joining a single-element list returns that element, so an absent or empty chain already yields the text alone. The early return that used to guard it was a branch with no behavior of its own.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Development docs](../../../docs/development.md) — the repository's TypeScript project layout and its two compiler planes.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package is a zero-dependency string utility that registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Only `text` and `messageChain` are read** — diagnostic category, code, and file position belong to the surface that reports them, which formats those alongside this sentence rather than inside it.
- **The separator is the caller's** — the walk joins with whatever string it is handed and neither indents nested levels nor trims the result, so a surface wanting the compiler's indented chain layout formats it itself.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
