# Agent Note：一整个包组以别人的注释为掩护离开了覆盖率门禁

Status: implemented

[English](2026-09-03-extension-group-left-the-coverage-gate.md) | 中文

## 问题

`vitest.config.ts` 在阈值正上方直接写明了规则："100% or it doesn't merge"，按文件计以便"a well-covered big file can't subsidize a bare one"，以及"Every v8 coverage exclusion comment must state its reason"。

该排除列表中有两行是 `packages/extensions/*/src/**/*.ts` 及其 `.tsx` 孪生行。它们位于一个以"Slash/command/input round: per-file gaps deferred with the same client-lane debt"开头的区块末尾，而那句话描述的是十一个具名的客户端斜杠命令文件，没有一句描述 `packages/extensions`——那是另一个组，装着 Cordis 的 Host 与 Client runner、`cordis_inspect` 工具及其浏览器卡片。该通配符继承了一条讲别的事情的注释，于是这项排除没有自己的理由，读起来像是某个无关批次的一部分。

它覆盖了什么，在改动任何东西之前度量：45 个文件，语句覆盖率 57.91%。十五个为零，其中包括 `tool-cordis`——一个面向模型的工具——以及 `ui-cordis` 的全部源文件。`cordis-client-runner/src/client/timer.ts` 为 3.79%，`cordis-host-runner/src/inspect-registry.ts` 为 3.73%。

开放的那一端比这个数字更要紧。通配符会为尚不存在的文件开脱，于是 `packages/extensions/` 下新增的每个文件在创建的那一刻就静默地离开了门禁。

## 决定

通配符被替换为四项阈值未全部达标的那 33 个文件，一行一个，并附一条说明它排除了什么、以及写下时度量到多少的注释。已经达标的十二个文件现在受门禁约束，而新增到该组的文件默认受约束，因为没有任何模式覆盖它。

枚举依据的是全部四项指标，而非仅语句覆盖率。第一遍按语句覆盖率筛选，放过了两个被门禁按分支覆盖率拒绝的文件——`ui-cordis/src/client/card-model.ts`，语句 100%、分支 84.9%；以及 `ui-cordis/src/index.ts`，它在任何测试套件下都不会被加载，因此不出现在任何汇总里，而门禁把它读作零。

## 备选方案

**现在就把该组做到 100%。** 十五个文件为零，两个包几乎没有测试套件；那是一个项目，不是一次编辑。先枚举让欠账可见且有限，每个文件在它的测试落地时离开这份清单。

**给通配符配一条自己的注释并保留它。** 那会修正张冠李戴，同时保留开放的那一端——正是让尚未写出的文件跳过门禁的那部分。一项无界排除即使写明了理由，仍然是无界排除。

**排除两个没有真实测试套件的包，让两个 runner 受门禁约束。** `cordis-host-runner/src/index.ts` 为 79%，`guard.ts` 为 70.93%，所以两个 runner 也不达标；这条界会划在包的位置上，而不是覆盖率的位置上。

## 影响

`packages/extensions` 进入了覆盖率门禁。十二个文件在四项指标上被守在 100%，33 个被点名为欠账，该组中新增的文件默认受约束，除非有人加一行说明不是。验证方式是把门禁限定到该组运行：没有任何一条阈值错误点到 `packages/extensions`。
