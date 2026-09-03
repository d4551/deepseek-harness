# Agent Note: 会话提交前暂存只有一个所有者

Status: implemented

[English](2026-09-03-session-staging-plumbing-owner.md) | 中文

## Problem

七个包各自在会话事件日志之上折叠一条由本包拥有的关系：`dsh-session`、`dsh-compaction`、`dsh-goal`、`dsh-hook-protocol`、`dsh-user-approval`、`dsh-tool-workflow` 与 `dsh-tool-todo`。每个包都在 `internal/dispatch` 期间校验候选值（在那里抛出失败即拒绝该次追加），并在 `session/event` 期间提交已接受的结果（此时事件已经在日志中）。每个包都为这道分工手写了同一套管道：一个存放每会话已提交状态的 `WeakMap`、第二个按事件对象暂存结果的 `WeakMap`、一个遍历 `session.events` 的播种循环、对首次在 dispatch 时见到的会话的接管，以及 `session/created` + `internal/dispatch` + `session/event` 这三个监听器。

`bun run duplication` 在这套管道内部报告了三处克隆：`dsh-compaction` 对 `dsh-user-approval`（12 行 114 个 token）、`dsh-compaction` 对 `dsh-hook-protocol`（12 行 74 个 token），以及 `dsh-hook-protocol` 对 `dsh-user-approval`（12 行 79 个 token）。另有三个配套模块携带同样的文本，只是刚好低于 jscpd 的 6 行／60 token 下限；`dsh-tool-todo` 则把它藏在一个 `jscpd:ignore` 标记之后，直到[标记 Agent Note](2026-09-03-duplication-suppression-that-suppressed-nothing.zh.md)移除了这套抑制机制。门禁当时报告的只是同一套重复设计中任意的一个子集。

[钩子桥接器抽取](2026-09-03-hook-bridge-and-invariant-plumbing-extraction.zh.md)推迟了这三处克隆，并提出了本 Agent Note 所回答的所有权问题；它的“Deferred”一节在此被取代。

两道门禁对这段文本的一部分存在分歧。`verify-package-invariants` 要求全部 261 个配套模块都以 `}, { inject: ['sessions'] })` 收尾其安装函数，并使用完全一致的标识符通过 `ctx.invariants.register(PACKAGE_NAME, install)` 注册；它的 AST 规则拒绝任何别的写法。`bun run duplication` 拒绝重复文本。一道门禁强制要求的逐字文本正是另一道禁止的，两边都不让步：注册尾部无法缩短、改名或参数化。

## Decision

### `dsh-session` 拥有这套管道

`@deepseek-ai/dsh-session` 声明了 `Session`、`SessionEvent`、`session/created` 与 `session/event`，并且是全部六个产品包的对等依赖（peer dependency）。它把共享管道发布在 [`./invariant-staging`](../../../../packages/core/session/src/invariant-staging.ts)，这个模块自己拥有其导出，而不是转发它们。

`stageSessionEvents(ctx, fail, staging)` 把这三个监听器安装为调用方 fiber 上的 `ctx.on` effect，持有状态表与暂存表，为存储中已有的每个会话播种，为每个被宣告的会话播种，并接管首次在 dispatch 时观察到的会话。`SessionEventStaging` 的各个步骤属于所有者：

- `seed(session)` 从会话已持有的事件构建已提交状态；
- `publish(state, event)` 推进由发布直接提交的状态，并报告该事件是否不需要暂存结果，轮次游标正是借此在无人认领的事件上继续移动；
- `stage(state, event)` 在候选值的追加提交之前校验它并返回要提交的内容，所有者忽略该事件时则返回 `undefined`；
- `claims(event)` 决定哪些已发布事件必须经过暂存，从而让跳过 dispatch 的发布失败，而不是静默提交；
- `commit(state, staged)` 折叠一个暂存结果，并返回将成为已提交状态的那个状态。

`TState` 被约束为 `object`，使已播种的会话可以与从未见过的会话区分开；否则接管查找会在每个事件上重新播种一个 nullish 状态。

同一个模块还拥有 `advanceOpenTurn` 与 `OpenTurnCursor`。`turn/start` 与 `turn/end` 属于会话词汇，而 `dsh-compaction`、`dsh-hook-protocol` 与 `dsh-user-approval` 各自保留了一份逐字节相同的游标副本；它们的 trace 现在扩展 `OpenTurnCursor`。`dsh-tool-todo` 保留自己的布尔轮次标志，它不记录轮次编号，也不需要游标。

### 每个包保留自己的关系

没有任何关系搬走。`dsh-compaction` 保留它的标记对、检查点与轮次边界规则，以及它对陈旧遗留锁的播种修复；`dsh-goal` 保留严格解码器的折叠；`dsh-hook-protocol` 与 `dsh-user-approval` 保留各自的配对词汇；`dsh-tool-workflow` 保留它的运行／成员折叠；`dsh-tool-todo` 保留它的快照与轮次包裹规则；`dsh-session` 保留 seq、轮次／步骤包裹以及工具调用与结果的配对。每个配套模块仍然通过强制要求的注册尾部注册自己的 `PACKAGE_NAME`，且没有任何产品包依赖另一个产品包。

五个配套模块各自在未暂存发布分支上携带的 `v8` 覆盖率排除已经消失：`packages/core/session/tests/invariant-staging.spec.ts` 直接触达该守卫的两半，因此共享模块无需排除注释即可被覆盖。

### 门禁冲突，实测

把这套管道抽取出来就已足够；仅凭强制要求的注册尾部并不会触发 jscpd。把残留中最相似的两个配套模块（`dsh-hook-protocol` 与 `dsh-user-approval`，从各自的 `install` 声明到文件末尾）单独取出比对，得到的最长共享片段为 **11 行 46 个 token**，从 `commit:` 条目一直到 `Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))`。token 下限是 60，因此余量为 14 个 token。

本笔记最初记录说这份余量中有一部分由注释文本承担——即 jscpd 5 在 `mode: mild` 下会对注释做 token 化，因此每个配套模块中点名自身包的 `apply` JSDoc 会打断那段连续文本。这是错的；之所以把更正留在这里，是因为错误的版本曾被当作一项维护约束引用。按本仓库的设置直接对着 jscpd 用双文件夹具实测：代码相同而注释**不同**，仍然报告一处克隆；代码不同而注释**相同**，则不报告任何克隆。注释文本既不制造克隆，也不打断克隆。那 14 个 token 的余量全是代码，而日后逐字复制另一个配套模块 `apply` 文档的做法，不会引入任何东西。

## Alternatives considered

**把这套管道放进 `dsh-invariants`。** 已否决：[包不变量约定](../architecture/2026-07-19-package-invariant-runtime-contracts.zh.md)规定中心服务不导入任何产品包，而这套管道完全以 `Session` 与 `SessionEvent` 来定义。

**添加 `jscpd:ignore` 标记或 `.jscpd.json` 的 ignore 条目。** 已否决：两者都只压下报告而不消除重复，而且文件内抑制机制正在从配置中移除。

**重塑其中一个配套模块，直到它落到检测器阈值之下。** 已否决，这是在钻阈值的空子。它让同一套设计的七份副本原地保留，任何一份一旦增长就会再次触发。

**削弱 `verify-package-invariants`，让注册尾部可以变化。** 已否决：精确名称的注册与受检的本地 `install` 正是让包所有权可审计的东西，而上面的实测表明注册尾部并不是那条起约束作用的限制。

**让共享模块把回放循环也一并拥有，把播种事件依次穿过 `stage` 与 `commit` 折叠。** 已否决：`dsh-compaction` 依据一条陈旧遗留锁修复规则回放继承来的前缀，而这条规则在实时路径上没有对应物，因此统一的回放会需要一个贯穿所有者各步骤的回放标志，或者把只用于回放的数据挂在实时 trace 上。

**把每个包的关系检查移入共享模块。** 已否决：产品词汇、依赖、测试与变更所有权都归属于产出这些数据的那个包，而这正是包所有的配套模块的全部意义。

## Consequences

- 一个模块拥有 dispatch 与发布之间的分工，因此对暂存工作方式的改动（顺序、接管，或 fail-closed 的守卫）只发生一次，每个所有者都会继承它。
- `bun run duplication` 报告的克隆中没有一处涉及这七个配套模块或共享模块。`dsh-tool-todo` 此前被抑制的、对 `plan/plan-mode` 的那处克隆也随之消失。
- `dsh-session` 新增一个已发布的子路径，每个不变量配套模块都在运行时解析它。它由 `tsc` 输出到 `lib/types/invariant-staging.js`，通过 `files` 中已有的 `lib/types/**/*.js` 条目发布，并且没有运行时导入，因此打包安装无需 bundle 入口即可解析它。
- `packages/core/tools/src/invariant.ts`、`packages/context/time-context/src/invariant.ts`、`packages/llm/llm-retry/src/invariant.ts` 与 `packages/goal/goal-round-driver/src/invariant.ts` 仍然手写这套管道或开放轮次游标的变体。它们尚未改造，是下一批候选。
- 若某个配套模块的 `claims` 与 `stage` 不一致，它现在会在发布时带着自己的 `unstagedMessage` 大声失败，而不是什么都不提交；这条路径有测试覆盖，而不是被排除在覆盖率之外。
