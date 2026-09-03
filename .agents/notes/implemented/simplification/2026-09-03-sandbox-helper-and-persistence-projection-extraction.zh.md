# Agent Note: 三处克隆被抽进本就拥有其词汇的 Service Definition

Status: implemented

[English](2026-09-03-sandbox-helper-and-persistence-projection-extraction.md) | 中文

## Problem

移除 `.jscpd.json` 的文件内抑制标记（[标记 Agent Note](2026-09-03-duplication-suppression-that-suppressed-nothing.zh.md)）后，浮现出三处此前被标记掩盖的克隆，每一处都长出了一条为自身重复辩护的注释。

`bash-sandbox/src/helpers.ts` 与 `pwsh-sandbox/src/helpers.ts` 是同样的 110 行——515 个 token，仓库中最大的一处克隆。只有模块头部不同，而 pwsh 那份副本的头部就是这么写的："deliberate call-for-call mirror of `@deepseek-ai/dsh-bash-sandbox/src/helpers.ts`"。[pwsh 工具与执行器 Agent Note](../feature/2026-08-01-pwsh-tool-and-executor.zh.md) 确实为并行的*工具*接口给出了理由，因为模型会看到两个工具。它没有为内部分类逻辑说任何话，而后者既不被模型也不被用户观察到，其中也没有任何一行依赖平台：每条规则都由所选 runner 公布的拒绝签名与 `RunnerFailureRule` 参数化，因此 bwrap、Landlock、Seatbelt 与 Windows ACL runner 本就流经同一条代码路径。

`session-persistence-jsonl` 与 `session-persistence-sqlite` 各自逐条写出了同样的八个到 `PersistenceCoordinator` 的转发——33 行。JSONL 那份副本携带着长期以来的理由："extracting these trivial forwards would add an inheritance layer."。两个提供方本就继承 `SessionPersistence`；这个层已经存在，缺的只是它的中间一层。

`inspector/.../runtime/frames.ts` 在同一个文件内把同一段信封与地址解析写了两遍，并配有一条注释宣称 "each wire parser spells out its own envelope literally instead of sharing a tag-parameterized helper."。没有任何东西强制执行这一点；两个解析器只差一个字符串。

## Decision

每一次抽取都归入本就拥有相应词汇的 Service Definition，并以具名子路径发布，使 Consumer 导入的是拥有者模块，绝不会是某个同级提供方。

`@deepseek-ai/dsh-shell/sandbox-classify` 拥有 `isRunnerSpawnFailure`、`classifyDenial`、`classifyRunnerFailure` 与 `matchesSignature`。shell seam 是唯一能同时命名两半的候选者：它声明了 `ShellRunResult` 以及这些函数所产出的 `ShellSandboxInfo` 事实，并且本就为 `RunnerFailureRule` 对等依赖 `@deepseek-ai/dsh-sandbox`。sandbox seam 若不获得对 shell seam 的依赖就无法承载它们。两个提供方包本就依赖 `@deepseek-ai/dsh-shell`，因此依赖图上没有新增的边。两个提供方都没有保留任何分歧行：整整 110 行全部是共有的。

`@deepseek-ai/dsh-session-persistence/coordinated` 拥有 `CoordinatedSessionPersistence<TornMarker>`，这是位于 `SessionPersistence` 与两个后端之间的抽象类，它实现那八个协调器转发，并声明 `protected abstract readonly coordinator`。每个后端只保留由其存储介质决定的部分：`locate`、`list`、`listSnapshots`，以及它的 `PersistenceBackend` 钩子。

在 `frames.ts` 内部，`assertFrameEnvelope` 与 `parseFrameAddress` 是每个 frame 解析器都会执行的两项操作，而 `parseRequestAddressedFrame` 为那两个除请求 id 之外别无内容的 frame 把它们组合起来。错误文本未变：逐 frame 的标签本就提供了唯一会变的那个词，因此 `invalid ${label} envelope` 逐字复现每一条消息。

## Alternatives considered

**把分类辅助函数放在 `packages/util/*` 里。** 它们确实是纯函数，但 `classifyRunnerFailure` 的类型来自 `RunnerFailureRule`，`classifyDenial` 的类型来自 `ShellRunResult`。一个零依赖的包必须重述这两者，于是把一处克隆换成了两处类型克隆。

**从各包的 `index.ts` 再导出这些新模块。** `no-barrels` 对已发布入口是允许的，`render.ts` 就是先例。这里改选子路径，是为了让导入直接点名拥有者，也是为了让两个 Service Definition 已记录的根接口——生成的 Cordis 目录会投影它——不因一次不增加能力的重构而移动。

**保留持久化转发，接受这处克隆。** 这正是文件内注释所主张的。它点名的代价是多一个继承层，而这个层就是一个抽象类，位于本就声明该抽象服务的包中；它没有点名的代价是：同一个 seam 的两个提供方中，八项操作会各自独立漂移。

## Consequences

`bun run duplication` 这三处一处都不再报告。`packages/shell/shell` 与 `packages/session/session-persistence` 各自新增了一份包内的 `tsdown.config.ts`，因为默认的工作区入口清单只打包 `index` 与 `invariant`，否则一次 packed 安装会把新子路径解析到一个不存在的文件。`bash-sandbox` 与 `pwsh-sandbox` 不再携带 `src/helpers.ts`；它们既有的纯辅助函数测试套件现在演练共享模块，并共同覆盖其每一个分支。
