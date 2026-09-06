# Agent Note: 重复检测门禁覆盖每一棵作者编写的 TypeScript 目录树

Status: implemented

[English](2026-09-06-duplication-gate-scope.md) | 中文

## Problem

`bun run duplication` 在 `packages scripts` 上运行 jscpd 并报告没有克隆。它从不读取的两棵目录树中也存在作者编写的 TypeScript：`apps/` 与 `website/`。用同一份配置在它们上运行找到了三处克隆——一处在 `scripts/client-ui-ssot.ts`，两条动效规则向守卫提出了同一个问题；一处是 `website/.vitepress/config.ts` 中在两个 locale 标签下写了两遍的编辑链接模式；还有 `website/docs.ts` 中两个相邻的 `pairedPages` 调用具有完全相同的映射体。

因此该门禁的沉默说的是"我读的那两个目录里没有克隆"，读起来却像"没有克隆"。

## Decision

该脚本点名每一棵作者编写的 TypeScript 目录树：`jscpd --config .jscpd.json packages scripts apps website`。三处克隆是被移除而非被开脱——一个共享的 `unansweredSelectors` 辅助函数、一个两种 locale 都经由其链接的具名 `editSourceUrl` 函数，以及一次合并后的 `pairedPages` 调用。在同样的 `minTokens: 60` / `minLines: 6` 设置下，1930 个文件中克隆数为零；这些设置保持不变：本次改动扩大的是门禁读取的范围，而不是放宽它拒绝的标准。

`.jscpd.json` 仍带有 `"ignore": ["**/tests/**"]`。该排除项是被测量过的，而非想当然：把测试包含进来运行会在 3321 个文件中报告 1877 处克隆，占行数的 2.74%。其中多数是说明用例如何准备的并列 arrange 块，但这一集合中也确实存在应当归入 `packages/test-support/*` 的逐字节相同的辅助文件——两个仅相差一个字符串字面量的 `assemble.ts`，以及三份 14 行的 `test-session-query.ts` 副本。收敛这些是另一次带自身棘轮的改动；在此记录该数字，是为了让这条排除项不至于被读作"那里什么也没有"。

## Alternatives considered

**现在就去掉测试排除项，并把百分比阈值设在测得的 2.74%。** 本次改动否决：只有当有人梳理过阈值之下究竟是什么之后，天花板才是诚实的，而这 1877 处克隆尚未被梳理。在梳理之前挑一个正好贴合当前代码树的阈值，正是本仓库视为软化的那种数字。

**因为 `apps/` 与 `website/` 不是交付的包而将其排除在外。** 否决：两者都是贡献者会编辑的作者编写的 TypeScript，而 `website/docs.ts` 正是投影页面表所在之处——恰恰是最容易被复制的那类表。

## Consequences

在 `apps/` 或 `website/` 中引入的克隆，现在会像 `packages/` 中的克隆一样让门禁失败。测试排除项予以保留，并写明其代价：在本代码树上测得 1877 处克隆，占行数的 2.74%。
