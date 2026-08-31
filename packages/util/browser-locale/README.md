---
description: "The browser locale preference rule shared by boot surfaces that paint before a locale service exists, and the policy for when a surface owns its own dictionary."
kind: "package-library"
---

# @deepseek-ai/dsh-browser-locale

English | [中文](README.zh.md)

## Summary

`dsh-browser-locale` answers one question for surfaces that render before the locale service exists: which of the locales the product ships does this browser ask for. It reads `navigator.languages` in preference order, falls back to `navigator.language`, treats a regional tag as its language so `zh-CN`, `zh-Hant`, and `zh` all select Chinese, and answers English when a run has no `window` or asks for a language the product does not ship. It carries no dependency of its own, so a boot shell waiting on the plugin tree can use it without joining that tree. Each surface still owns its own copy dictionary; what they share is the preference rule alone.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Further Exploration](#further-exploration)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Reach for this when a surface paints its own copy before the locale service is available. Keep the dictionary in the surface that renders it and take only the resolution here.

### Resolving the locale a browser asks for

```ts
import { resolveBrowserLocale } from '@deepseek-ai/dsh-browser-locale'
import type { BrowserLocaleId } from '@deepseek-ai/dsh-browser-locale'

interface BootCopy { readonly loading: string }
const DICTIONARIES: Record<BrowserLocaleId, BootCopy> = {
  en: { loading: 'Loading' },
  zh: { loading: '加载中' },
}

/** Boot copy for one locale; omitted, the browser decides. */
export function bootCopy(locale: BrowserLocaleId = resolveBrowserLocale()): BootCopy {
  return DICTIONARIES[locale]
}
```

### Passing tags explicitly

Tests and non-browser callers pass the tags instead of letting the module read the browser:

```ts
import { resolveBrowserLocale } from '@deepseek-ai/dsh-browser-locale'

const locale = resolveBrowserLocale(['fr', 'zh-CN', 'en'])
```

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `BrowserLocaleId` and `resolveBrowserLocale` — the whole package |
| [`src/invariant.ts`](src/invariant.ts) | Invariant companion (no runtime invariant; tag matching is enforced by unit tests) |

### Why a run without a window answers English

`navigator` exists on the host global outside a browser and reports the machine's language. A server-side or worker-host run must not take a page's locale from the operating system, so the module admits the browser only when `window` is defined.

### Why it stays dependency-free

A boot shell paints before any plugin loads, so it cannot depend on the locale service it is waiting for. Keeping the rule in a package with no dependencies of its own lets that shell share it anyway.

</details>

-----

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

The shipped locale set is fixed at `en` and `zh`, matching the copy the product ships. A third locale changes this module's type and every dictionary that keys on it, so the set moves deliberately rather than by configuration.

-----

<a id="further-exploration"></a>
## Further Exploration

- [Client locale package](../../client/locale/README.md) — the locale service that owns copy once the plugin tree is running.
- [Internationalization docs](../../../docs/i18n/README.md) — how the repository handles bilingual content.

-----

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
