# Agent Note: 根 README 的导览，以及徽章下面的一道门禁

Status: implemented

[English](2026-09-02-root-readme-orientation-and-badge-gate.md) | 中文

## Problem

根 README 一开篇讲的是 `dsh` 由什么构成——Cordis、一切皆插件的架构、本 fork 固定的工具链——却从不讲它为眼前这位读者做什么。顺着链接过来的人得先读到架构文档，才知道 harness 是位于自己与模型之间的那一层，也才知道一项能力是由三个可分离的角色构成的。解释本仓库其余全部规则的那两条事实——模型可见 ⟺ 已记录，以及 Service Definition / Provider / Consumer 的拆分——在读者最先落地的那一页上根本没有出现。

README 还会声明版本，而没有任何东西去读它。本 fork 在 `package.json` 中固定了 TypeScript 7.0.2、bun 1.4 和 Vitest 4；一次升级会移动这些值，却把散文里的声明留在原地，让它继续断言一个仓库已经不再使用的版本——而这恰好是读的人最多、测的人最少的那个文件。

## Decision

README 依次承载一行徽章、一节 `Explain like I'm five`，以及一张描述单个轮次的 mermaid 图，位置在 fork 专属的 `This checkout` 一节之前。

`scripts/root-readme-badges.spec.ts` 从 `package.json` 推导每个版本徽章——`typescript` 与 `vitest` 取自依赖范围，bun 取自 `packageManager`——并断言两个语种侧携带逐字节相同的徽章标记，因此一次升级不可能只落到其中一侧。`run-gates.ts` 把它与 `doc-standard.spec.ts` 放在同一个 `doc-standard-tests` 叶子里运行，于是它同时进入 `test:docs` 与 `doc-sync`。

徽章排在同一个物理行上，因为「每段一行」由 `verify-md-wrap` 掌管；该 spec 因此从那一行里读出徽章，而不是逐行读取。

图中节点标签在两个语种侧都保持英文，沿用 `docs/agent-lifecycle.md` 已有的双语 mermaid 约定：图本体在两个文件中完全一致，只翻译其周围的散文。

## Alternatives considered

**为工作区包数量加一枚徽章。** 对一个一切皆插件的 harness 来说，251 是个醒目的数字，但每落地一个包它就会漂移。计数徽章只有配上一道会更新它的门禁才诚实，而一道去更新无人阅读之数字的门禁，收益抵不过它给无关改动带来的噪声。

**让徽章不设门禁。** 少一个文件，更省事，而这正是声明腐化的原因：声明版本的散文，恰恰是没有测试去读的散文，于是移动它的那次升级也就没人会注意。

**翻译图中节点标签。** 出于与现有时序图相同的理由拒绝：这些标签是包名与事件名——`agent-loop`、`system-prompt`、`llm`——翻译它们会让图与它所描述的代码树脱节。

## Consequences

如今一次工具链升级会让一道文档门禁失败，直到 README 在两个语种侧都写出它升到的版本为止。这确实让升级时多出一个要改的文件，而这正是目的所在。

图中陈述了四个插件角色和一份 seam 清单。它画的是循环，不是代码树，所以有包落地时它不必变动；当循环本身的形状改变时它必须变动，而 `docs/architecture.md` 本来就要求那种改动必须被记录下来。
