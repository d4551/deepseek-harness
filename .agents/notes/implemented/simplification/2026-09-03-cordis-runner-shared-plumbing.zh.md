# Agent Note: cordis runner 的重复可以抽取；有一对 guard 孪生副本不行

Status: implemented

[English](2026-09-03-cordis-runner-shared-plumbing.md) | 中文

## Problem

移除 `.jscpd.json` 的文件内抑制标记（[标记 Agent Note](2026-09-03-duplication-suppression-that-suppressed-nothing.zh.md)）后，三个 cordis 扩展包里浮现出八处克隆。它们分成看起来相似、实则不同的两类。

其中四处位于同一个人工编写的文件 `cordis-host-runner/src/index.ts` 内。五个服务方法各自手工重建同一份不含来源信息的 Plugin 行：`inventory`、`snapshot` 与 `inspectPlugin` 中的 `[...plugin.packages.values()].map(...)`，以及 `inventory`、`reference` 与 `inspectPackage` 中的 `currentPackageId`/`nextPackageId`/`activeRun`/`latestRun` 尾部。三个私有 steering（中途引导）方法各自围绕不同的消息重跑同一套 claim-agent-steer 序列。没有任何东西把这些副本区分开；它们唯一必须保持一致的是键序，而这份一致由人工维护。

另外四处横跨 Host 与 Client 两个平面：两份 `providers.ts` 的 inspect-provider 工厂、两份 guard 代理，以及 `cordis-host-runner/src/index.ts` 中的 `errorDetails` 与它在 `cordis-client-runner/src/client/runtime.ts` 中的孪生副本。每一对都是有意写两遍的、完全相同的面向模型行为，`cordis-host-runner/src/guard.ts` 的散文已经这样写着：“Folding them together is not available — the two halves compile in separate programs where `Context` merges different service keys.”

## Decision

四处自身克隆被抽取出来。`cordis-host-runner/src/projection.ts` 拥有对活动 Plugin 的每一种不含来源信息的投影——`packageSummaries`、`versionPointers`、`activeRunPointer`、`latestRunPointer`，以及把后三者折叠起来的 `lifecyclePointers`——外加把一次尝试与注册表状态分离的私有 `cloneAttempt`。发射顺序现在是折叠本身的性质，而不再是五个调用点各自的性质：`snapshot` 仍然在 `packages` 之前发射它的版本指针，并以只属于 Host 的 `activeRun` 取代普通的那个，而它由相同的零件组合出这些内容。`steerRuntimeFailure` 拥有面向 handler 与 guard 报告的 claim-then-resolve-then-steer，`steerUserContext` 拥有全部四条 steering 路径所用的、带插件归属的 `agent.steer` 信封，与它旁边本就存在的 `injectUserContext` 相对称。

四处跨平面克隆保留原样。它们的共同拥有者必须是两个平面在运行时都会导入的模块，而这三个包内部没有任何模块能担此角色。已发布的 client bundle 拒绝这种做法：`packages/client/tsdown.client.ts` 中的 `dsh-client-bundle-purity` 会对浏览器 bundle 中任何 `@deepseek-ai/` **值**导入抛错，除非它是模块表中的一行、一个 vendor 库、一份生成的 `/remote` 贡献，或 `INLINE_SAFE` 中的一个名字。直接执行该判定会拒绝 `@deepseek-ai/dsh-cordis-host-runner` 及其除生成的 `/remote` 之外的每一条子路径。仅类型导入在门禁看到之前就被擦除，这正是 `cordis-client-runner` 已经通过 `@deepseek-ai/dsh-api-remotes/client` 读取 runner 的协议格式（wire format）词汇、并且不从任何 Host 包导入值的原因。反方向更糟：Host 将对它所服务的浏览器一侧产生运行时依赖，而 `cordis-client-runner` 只发布它的 bundle 和它的声明文件。

## Alternatives considered

**把共享管道放进 `cordis-host-runner`，由浏览器一侧导入。** 这正是两个平面想要的那个模块，而 `INLINE_SAFE` 描述的类别也涵盖它——“contract layers and pure folds a client bundle may inline”。要让它成立，需要往那份允许清单里加一条子路径，作用范围与既有的 `@deepseek-ai/dsh-token-meter/client$` 条目相同。那份允许清单是这几个包之外、由别处拥有的打包决定，因此它应当被刻意做出，而不是作为一次重复修复的副作用。

**由 `cordis-client-runner` 拥有，再从 `tool-cordis` 导入。** 已否决：这会颠倒分层，而且该 Client 包的 `files` 并不发布任何可供 Node 消费方导入的 JavaScript。

**改写其中一侧，让两者不再匹配。** 已否决。Host 与 Client 的 inspect 接口是同一份面向模型的约定；为了迎合文本比对而用两种不同写法表达它，只会让这一对更难保持一致，并陈述一种并不存在的不对称。

**像 `api-catalog.ts` 那样生成两份副本。** 这是仓库对同一问题的既有答案，它会把这些区段移进生成器的输出，那里有路径豁免覆盖。这件事属于 `scripts/gen-cordis-inspect-catalog.ts`，不属于这几个包。

## Consequences

`bun run duplication` 不再报告 `cordis-host-runner/src/index.ts` 内的任何克隆；该文件减少了 172 行手工重复的投影与 steering 代码。四处跨平面克隆在那个时点仍被报告，未被抑制、清晰可见，等待上面那个允许清单问题的裁决；下面的后续小节裁决了它，并抽取了其中三处。行为没有变化——投影按相同顺序发射相同的键，steering 消息及其“每次失败只报一次”的 claim 未变，`packages/extensions` 的测试原样通过。

## Follow-up: the allowlist question, decided

四处跨平面克隆中的三处现已抽取；guard 孪生副本保留，理由已被更正。

**子路径。** `cordis-host-runner/src/wire-values.ts` 是其 `./types.ts` 所声明的、client 可安全使用的协议格式词汇的值半边：`errorDetails`、Service 与 Event inspect 查询的 JSON Schema 常量、`exactInput`、`readExact`，以及把单方法 manifest（元数据清单）与调用方自己的 handler 配对起来的 `inspectProvider`。它还持有下文那条 guard 规则所需的 `CTX_VERBS`、`TIMER_VERBS` 与 `ctxVerbForwarder`；它们放在这里而不是放进同级模块，是因为允许清单条目锚定的正是这一个模块。它只导入两个类型，此外什么都不导入，不触及任何 Cordis 服务、任何 Node 模块和任何浏览器 API，其产出的 JavaScript 完全不带 import。它以 `./wire-values` 的形式从 `lib/types/wire-values.js` 发布，与 `./types` 的发布方式相同，因此无需新增 tsdown 入口，也无需改动 `files`。`cordis-host-runner/src/index.ts`、`tool-cordis/src/providers.ts`，以及 `cordis-client-runner` 的 `src/client/providers.ts`、`runtime.ts` 和 `orchestrator.ts` 都由它构建这些记录；`cordis-client-runner` 新增了工作区依赖与项目引用，其 Client face 本就有先例——`api/remotes` 的 Client 叶子配置为 `./types` 引用的正是同一个 Host 包。

**允许清单的改动。** `packages/client/tsdown.client.ts` 中的 `INLINE_SAFE` 新增了一条锚定的可选项 `@deepseek-ai/dsh-cordis-host-runner/wire-values$`，作用范围与旁边的 `@deepseek-ai/dsh-token-meter/client$` 条目完全一致。执行门禁自身的 `resolveId` 会接受该 specifier，并仍然拒绝 `@deepseek-ai/dsh-cordis-host-runner`、`/types`、`/wire-values/nested` 与 `/wire-values-extra`。构建 `cordis-client-runner` 的浏览器 bundle 可确认效果：schema 文本与 `errorDetails` 被内联，而 `@deepseek-ai/cordis` 仍是该 bundle 唯一的 `@deepseek-ai` require。

**guard 孪生副本：dispatch 共享，陷阱保持两份。** 该文件原先的散文说折叠不可行，因为两半在各自独立的程序中编译，其 `Context` 合并了不同的服务键。这并不构成阻碍：一个在上下文对象类型上泛型化的工厂可以索引 `ctx[prop as keyof C]`，并在两侧都能编译。把匹配区段内部的机制与策略分开，才得出正确答案。它的内核——「转发一个 Context 动词，并拒绝插件未声明的 timer mixin」——是一条有名字的规则，不含任何属于某一半的内容：`CTX_VERBS` 与 `TIMER_VERBS` 在两侧成员完全相同，查找与 apply 也完全一致。它现在是 `ctxVerbForwarder`，由两个 guard 共同调用。没有任何东西被移出真正执行它的操作：`denyRead` 由调用方传入，因此每一半仍自行裁决拒绝什么、以及这次拒绝要讲清什么。

保持写两遍的是围绕它的那些陷阱，而它们的每一个决定都归属于某一半：只有 Host 才提供的 `tools` 席位、`get` 交还什么、两份措辞不同的 `denyRead` 教学文本、`set` 中的只读措辞，以及在两侧从不同门面 API 起始的 `has` 可达性判断。这些是策略，而执行拒绝的 guard 就是裁决这次拒绝的地方。抽取之后它们不再匹配：两组陷阱之间最长的相同 token 连续段为 47 个 token，低于 60 个 token 的下限，因此 `bun run duplication` 在 `packages/extensions` 中不再报告任何克隆。

**影响。** `bun run duplication` 在 `packages/extensions` 下找不到任何克隆。`scripts/client-bundle-purity.spec.ts` 用与 `token-meter/client$` 先例相同的「接受/拒绝」配对钉住了这条新条目。
