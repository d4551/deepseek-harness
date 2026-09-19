---
description: "The Thrown rejected-value union for handlers that observe a throw or Promise rejection, and the policy for when to annotate it."
kind: "package-library"
---

# @deepseek-ai/dsh-thrown

English | [中文](README.zh.md)

## Summary

`dsh-thrown` names the full set of values a throw or a Promise reject arm may deliver with its `Thrown` union: `object` for `Error` instances and every structured value, the six primitives callers throw as literals, and `null`/`undefined` for bare rejections. Handlers annotate the boundary where they observe the value — the `catch` parameter, the `.catch` callback, the recorded failure — instead of narrowing to `Error` and silently excluding what the runtime can actually deliver. It is a type-only package with no runtime code and no dependency on other harness packages, so any package can name what it caught without importing an unrelated capability package. Packages that observe rejections — settlement teardown, persistence barriers, transport shutdown, approval slots — annotate that observation with `Thrown` and narrow to `Error` or a domain shape only where the handler has evidence for it.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Annotate the boundary where a package observes a rejection with `Thrown`; never redeclare the union locally. A handler that records or forwards what it caught keeps the full value, and narrowing happens at the point the handler has evidence for a smaller shape.

### Annotating an observation

Import the union and annotate the `catch` parameter or the recorded failure:

```ts
import type { Thrown } from '@deepseek-ai/dsh-thrown'

async function disposeManagedProcesses(): Promise<void> {
  const failures: Thrown[] = []
  const recordFailure = (error: Thrown): void => {
    failures.push(error)
  }
  // ... await work with .then(undefined, recordFailure) ...
  if (failures.length > 1) throw new AggregateError(failures, 'teardown failed')
}
```

The annotation is erased at compile time. Once observed, the value flows through the handler as an ordinary value: it records, forwards, aggregates, and renders without any special handling.

### When to annotate

Annotate the boundary where the value is observed — `catch` parameters, rejection callbacks, recorded-failure collections, and functions such as message formatters that accept whatever a rejection delivered. Do not annotate values the package itself constructs: a function that only ever throws `Error` instances keeps its own precise type, and the cost of the shared union is paid only where an arbitrary thrower stands on the other side.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The union is one direct alias: `object | string | number | boolean | bigint | symbol | null | undefined`, covering every value JavaScript can throw.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `Thrown` union — the whole package |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; coverage is enforced by the compiler) |

### Why the union is complete

JavaScript places no restriction on the operand of `throw` or the argument of `Promise.reject`, so the union must accept every inhabitant of the language: `object` covers `Error` instances and all structured values, the six primitive constituents cover literal throws, and `null`/`undefined` cover bare rejections. A narrower annotation at the observation boundary is a claim the handler cannot prove; narrowing belongs where evidence exists.

### Why it stays dependency-free

Keeping `Thrown` in its own package means a transport, a store, or a UI slot can name what it caught without importing an unrelated capability package just to reach the vocabulary, and the rejection vocabulary has exactly one owner.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when you need the rejection handling this vocabulary names or the type conventions around it.

- [Core subsystem](../../../docs/subsystems/core.md) — where the shared agent/session lifecycle and the type rules are documented.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
