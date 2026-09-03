# Agent Note: Shared Client folds and pending settlement

Status: implemented

[English](2026-09-03-shared-client-folds-and-pending-settlement.md) | 中文

## Problem

两个 Conversation target 把同一份持久化 Session 数据投影了两遍。`ui-chat/src/client/conversation-nodes/event-projection.ts` 与 `ui-trajectory/src/client/trajectory-event-projection.ts` 是同一条从已记录的 `user/message`、`assistant/chunk` 或 `tool/call` 走到 transcript 行所渲染的视图记录的路径；Tool 调用构造器、Assistant 块累积与 inbox 拼接也在各自的 node 定义里被复制。`ui-subagent` 与 `ui-workspace` 各带一份 subagent 后代折叠，`ui-approval` 与 `ui-user-questions` 各带一份围绕 `uiSession.registerPendingInteraction` 的 pending-interaction 发布/等待/委派生命周期，两者都带着写明此事的 `jscpd:ignore` 标记。

去重是对的。第一版落地把这些折叠提升进 `ui-conversation` 与 `ui-session`，并添加 `dsh.client.external` 行让副本能解析，这让六个 Client 功能包违反了 [`packages/client/AGENTS.md`](../../../../packages/client/AGENTS.md) 陈述、[`verify-client-packages`](../../../../scripts/verify-client-packages.ts) 强制的规则：功能插件不得运行时导入另一个功能插件的值，且 `dsh.client.external` 不是功能插件的依赖机制。原因在于浏览器模块图——跨 row 的值请求必须由模块表回答，这会让插件加载顺序与 row 环在两个本应只共享声明的包之间变得举足轻重。

## Decision

七个共享值按其本质而非来源拆分。

**纯折叠进入一个静态链接、由外壳播种的包。** [`packages/client/ui-projection`](../../../../packages/client/ui-projection/README.zh.md)（`@deepseek-ai/dsh-client-ui-projection`）拥有 `event-projection.ts`、`assistant-stream.ts`、`messages.ts`、`tool-calls.ts`、`subagent-lineage.ts` 与 `pending-composer.ts`。每个导出都是无状态函数或冻结常量：`contextProvenance`、`sessionRecallLabels`、`toAssistantBlocks`、`displayFailure`、`SYNTHETIC_SEQ_OFFSETS`、`indexSubagentDescendants`、`settlePendingComposer` 及其同类都只读取调用方已持有的参数。没有任何代码按标识比较这些值，因此副本在正确性上是空操作，只带来 bundle 体积成本——但本包仍然是一个 `PLATFORM_MODULES` 词条，于是 `apps/web` 只链接一份，外壳把它播种进冻结的模块表供每个动态 bundle 使用。这正是 `client/store`、`ui-slots` 与 `ui-primitives` 已在使用的通道；随后 gate 会拒绝在 `dsh.client.external` 中重复声明 baseline 模块的消费方，消费方只在 `devDependencies` 中声明本包。

**唯一的生命周期归给拥有它的 service。** `settlePendingInteraction` 不是折叠。它的步骤——发布进 domain、等待呈现的结果、当拒绝是委派标记时恢复 Host waterfall、在任何结果下移除发布、并释放 teardown 的 `completed` 闸门以便 `registerPendingInteraction` 的 effect 完成销毁——属于 `UiSession` 的发布契约，而非消费方。`registerPendingInteraction` 现在返回 `PendingInteractionSettler` 而不是裸的 `PendingInteractionPublisher`，于是发布与结算成为一个操作、一个结算点，`ui-approval` 与 `ui-user-questions` 各自缩减为 `settle(pending, next)`。domain 的 `active` 重入守卫随之移除：settler 在其 `finally` 中恰好移除一次，而已被 teardown 的 `release()` 取走的值由 `values.delete` 的返回值兜住。

该静态包不对任何 Client row 产生运行时依赖。它仅以 `import type` 从 `@deepseek-ai/dsh-client-ui-conversation/client` 读取 `AssistantBlock`、`ConversationMatch` 及其同类，因此该边在 emit 前即被擦除，只有 tsconfig reference 记录它。`ui-conversation` 不再重新导出这些折叠——它从未调用过它们，转发它们正是让它看起来像其归属者的原因。

## Alternatives considered

**删掉 `dsh.client.external` 行，让每个消费方内联 `ui-conversation/client`。** bundle purity 插件会直接拒绝；即便不拒绝，内联一个动态 row 的入口会把 `ConversationController` 与 `UiConversation` service 类复制进功能 bundle。那不是重复的折叠，而是重复的归属者。

**把折叠放到 `uiConversation` 与 `uiSession` service 上。** gate 自己的诊断建议注入的 service，对 `settlePendingInteraction` 而言是对的。但对约二十五个纯函数是错的：每个折叠一个 service 方法会把 Service Definition 变成命名空间，而 [`packages/AGENTS.md`](../../../../packages/AGENTS.md) 把 service 方法保留给该 service 拥有的行为。`settlePendingComposer` 在调用点也没有 ctx——composer 的 React 处理函数是在呈现对象上调用 `pending.answer(...)`。

**把 Conversation 契约类型也搬进共享包，让类型边指向下层。** `contract/records.ts` 与 `contract/conversation.ts` 声明了可合并扩展的 `ConversationTurnDataMap`、`ConversationStepDataMap` 与 `ConversationViewSnapshotMap`，`ui-chat`、`ui-tool` 等通过 `declare module '@deepseek-ai/dsh-client-ui-conversation/client'` 增广它们。搬走它们要在十余个包中移动每一处增广目标，换来的只是一个在 emit 时即被擦除的类型图方向。README 转而记录这一倒置。

**把本包加进构建 preset 的 `INLINE_SAFE` 名单而非 `PLATFORM_MODULES`。** `INLINE_SAFE` 描述的正是这类值，因此每个 bundle 一份私有副本也能工作。但那会修改 purity gate 自身对“安全”的定义以接纳一个新包，并为十几个 bundle 省下的字节放弃单实例保证。播种只需在 `platform.ts`、`seed.ts` 与 seed spec 中各加三行，随后 gate 会检查这两半。

**把 `settlePendingComposer` 还原为每个 composer 包内的私有函数。** 那正是 `HEAD` 的做法，两个包中都带着 `jscpd:ignore` 标记。为了还原副本而重新加入抑制，正是该检测器要防止的做法。

## Testing

`packages/client/ui-projection/tests` 承载迁移过来的折叠套件，外加一份直接的 `settlePendingComposer` spec 与 invariant 伴生 spec；本包达到仓库要求的逐文件 100% 覆盖率。

`ui-session.client.spec.ts` 钉住 service 路线换来的单一归属者性质。注册在同一个 `UiSession` 上的两个 domain 发布进同一份 `pendingInteractions` snapshot，且优先级更高的条目胜出，因此 composer takeover 只显示一行。同一测试随后在自己的 Cordis root 上构建第二个归属者——即重复注册表的样子——并展示每份副本只看见自己的 domain，于是外壳唯一的 `sessionPendingInteraction` root hook 会遗落另一个。Cordis 本就拒绝在同一个 Context 上注册第二个 `uiSession`，这正是副本需要独立 root 的原因。

`ui-trajectory/tests/client-bundle.client.spec.ts` 读取真实 tsdown 产物：其模块表失去了 `@deepseek-ai/dsh-client-ui-conversation/client`、获得了 `@deepseek-ai/dsh-client-ui-projection`，这是以字节而非 manifest 陈述的模块图变化。

## Consequences

六个功能包不再请求跨 row 的运行时模块，浏览器模块表转而多出一个由外壳播种的词条。折叠现在只有一个归属者，因此对 Assistant 块走查的修改会同时到达 Chat 与 Trajectory。

代价是向 `ui-projection` 添加导出成为一次 shell 变更：只有当 `PLATFORM_MODULES` 与 `packages/client/web/src/seed.ts` 收录本包后，该名字才可解析。成员规则刻意收窄——模块状态、Cordis API，或调用方按标识比较的值都会取消资格，因为被播种的表是“只有一个实例”这一事实的唯一依据。

`registerPendingInteraction` 的返回类型变了，因此未来的 pending-interaction domain 拿到的是已结算的生命周期，而不是一个必须自行正确驱动的 publisher。两个 composer 包的测试台现在伪造 settler 而非 publisher。

## Related

[Shared Client row primitives](2026-09-03-shared-client-row-primitives.zh.md) 通过 `ui-primitives` 在上一层的 CSS 与 React 组件中移除同类重复。
