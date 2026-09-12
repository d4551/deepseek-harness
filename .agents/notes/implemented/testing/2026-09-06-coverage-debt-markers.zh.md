# Agent Note: 覆盖率排除项声明为结构性或带标记的欠债

Status: implemented

[English](2026-09-06-coverage-debt-markers.md) | 中文

## Problem

[`docs/testing.md`](../../../../docs/testing.zh.md) 告诉读者 [`vitest.config.ts`](../../../../vitest.config.ts) 中的覆盖率排除项带有"一份带标记的欠债清单（`TODO(gui)`、`TODO(inspector)`、`TODO(webworker)`），等待浏览器级测试通道"。而这些标记在整个仓库中的数量是零。没有任何条目携带标记，没有任何检查寻找标记，125 条排除项之间只由散文注释分隔，因此这份欠债既无法枚举也无法收敛。

其中五条指向的路径已不在代码树中：`packages/self-modification/*/src/**/*.{ts,tsx}`（一个已更名为 `packages/extensions/` 的包组，`AGENTS.md` 中的仓库结构清单同样仍写着旧名）、一个已移入 `rows/` 的 `ui-workspace` 组件、两个已删除的 `ui-chat` 模块，以及一个 Inspector 插件入口。它们各自什么也没豁免，却仍读作门禁有意给出的豁免。

## Decision

排除项要么是结构性的，要么是带标记的欠债。[`coverage-debt.ts`](../../../../scripts/coverage-debt.ts) 中的 `STRUCTURAL_EXCLUSIONS` 列出了十五条结构性 glob——没有运行时覆盖率可测量；执行组合位于 Worker、浏览器 realm 或子进程中而单元进程的 V8 无法观测；或者是只存在于 `lib` 中、由构建后冒烟测试执行的、为 Client 生成的 Host 代码。其余一律默认视为欠债，必须携带三个已记录标记之一，这样新增的排除项会进入欠债清单，而不是因遗漏而混入结构性集合。

`bun run verify-coverage-debt` 在静态通道中运行，并在同一形状的各种情况下失败：没有标记的欠债条目、配置已不再排除的结构性 glob、在代码树中匹配不到任何文件的 glob、没有任何条目使用的已记录标记，以及——自[测量记录](2026-09-12-coverage-debt-measurement.zh.md)起——已被另一条目整体覆盖的条目和匹配不到任何文件的平台条件通道条目。成功时它按通道打印数量，既有 glob 数也有文件数，这正是收敛时要压低的数字。这些标记最初拼作 `TODO(...)`；那篇记录把它们改名为 `DEBT(gui)`、`DEBT(inspector)` 与 `DEBT(webworker)`，因为契约禁止旧词出现在门禁中，而 `bun run measure-coverage-debt` 则是说明哪些条目可以删除的读数。

花括号选择在匹配前先行展开，因为 Node 的 glob 不支持它，否则每一条带花括号的排除项都会被报告为匹配不到任何文件。`packages/*/*/src/oxlint-contract-*.ts` 被列为暂时性条目：被终止的可执行 lint 契约测试可能留下一个源码探针，而在干净的代码树中匹配不到任何文件正是它应有的样子。

`DEBT(gui)` 欠债的收敛顺序从大到小：`packages/client/ui-tool`、`ui-slots`、`ui-layout`、`packages/client/web` 与 `packages/host/webserver` 是整包豁免，每个都是一条 glob 而非文件清单。

## Alternatives considered

**改写 `docs/testing.md`，改为描述散文注释。** 否决：那条声称本身是更好的设计。标记让欠债可 grep、可计数；删掉这条声称只会让 125 条排除项失去把手。

**按路径模式而非显式清单分类。** 否决：`packages/*/*/src/types.ts` 与 `packages/client/ui-tool/src/*` 都是 `packages/*/*/src` 形态的 glob，没有任何模式能区分"没有覆盖率可测量"与"等待某条通道"。这一区分是判断，因此把它写下来。

**对任何排除项一律失败，把清单收敛到空。** 否决：结构性条目不是欠债，永远不会关闭，因此把它们计入的门禁永远到不了零，也就不再具有意义。

## Consequences

新增排除项意味着要么把它论证进 `STRUCTURAL_EXCLUSIONS`，要么标出它所等待的通道。删除源文件现在会让门禁失败，直到其排除项一并删除——这正是产生那五条死条目的情形。打印出的清单数量就是棘轮：它只应下降。
