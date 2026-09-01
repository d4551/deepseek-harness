# Agent Note: 修复 browser-locale 与 diagnostic-text 的变异测试层覆盖

Status: implemented

[English](2026-09-01-mutation-tier-browser-locale-coverage.md) | 中文

## 问题

`bun run mutation` 在本地以 96.88 低于 99 的下限而失败。报告显示的是两处真实缺口，而非等价变异体：`packages/util/browser-locale` 与 `packages/util/diagnostic-text` 没有随包提供 `tests/invariant.spec.ts`，与变异测试层中其他每个包都不同，因此它们的 `invariant.ts` 伴生模块产生了 `NoCoverage` 变异体；而 `browser-locale` 的 `resolveBrowserLocale` window 路径——即对 `navigator.languages` 的 `typeof window` 读取以及 `navigator.language` 回退——完全没有测试，因为只有 tags 覆盖路径与无 window 路径被执行到。只有当 `mutate` 中的每个包都把测试列入 `vitest.mutation.config.ts` 的 include 时，该层的棘轮才立得住；把包加入该层却不带伴生规格，会悄悄拉低下限。CI 记录的 99.08 早于这次漂移，所以是本地运行发现了它。

## 决策

两个包都补上了缺失的伴生规格，形态与 `atomic-write/tests/invariant.spec.ts` 相同。`browser-locale.spec.ts` 用 `vi.stubGlobal` 用例覆盖 window 路径，并由 `vi.unstubAllGlobals()` 拆除：无 window 用例证明 `navigator` 未被读取（即使打桩为 `zh` 仍得到 `en`），其余用例钉住按偏好顺序的读取，以及只有 `languages` 与只有 `language` 两种宿主形态。

`resolveBrowserLocale` 的回退改为读取 `languages ?? [language]`，而不再在 `languages` 列表之后追加 `navigator.language`——这正是文档契约原本的说法：`languages` 缺失时由 `language` 承担整个列表；而当两者报告相同的首个标签时，追加是多余的。无 window 的 `[]` 数组字面量带有 `Stryker disable next-line ArrayDeclaration` 注释：任何垃圾替换都不含 `zh` 标签，返回的 locale 不会改变，而该分支本身仍由无 window 测试钉住。该文件得分 100/17，该层剩余的存活变异体是 `stryker.config.mjs` 中已记录的七个等价体。

`stryker.config.mjs` 的 `ignorePatterns` 也列入了 `.audit-tmp`。Stryker 的沙箱复制器在拷贝 `.audit-tmp/bun-cache` 内的一个 socket 时以 `ENOTSUP` 失败，该目录与已被忽略的 `coverage`、`dist-exe` 一样属于非源码残留。变异与测试范围均未改变。

## 考虑过的替代方案

**把 `NoCoverage` 变异体记为 `stryker.config.mjs` 中的等价体。** 该列表存在的意义是收纳测试无法区分的变异体。这些是有行为可达却没有测试的代码，记入等价体等于把等价列表花在覆盖缺口上，并让棘轮描述的东西与实际被测的东西脱节。

**保留在 `languages` 列表之后追加 `navigator.language`。** 只要两者报告相同的首个标签，追加就是多余的；而且文档契约本就把 `language` 定为整份列表的回退而非末尾一项，因此追加是为第一条规则已覆盖的情形又立了第二条规则。

**让无 window 的 `[]` 字面量保持可变异，容忍该存活体。** 那会为一个其替换根本无法改变返回 locale 的变异体，把整层压在下限之下；disable 注释只作用于这一处字面量，分支本身仍有自己的测试。

## 后果

变异测试层中的每个包现在都有 `invariant.ts` 伴生规格，因此某个包加入该层却不带伴生规格会成为可见的遗漏，而不是悄然拉低下限。`browser-locale` 现在只有一条回退规则，而不是两条。
