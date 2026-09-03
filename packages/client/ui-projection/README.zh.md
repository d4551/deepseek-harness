---
description: "从持久化 Session 数据到 Client 视图值的纯投影，静态链接并为每个 Client row 只播种一份。"
kind: "package-library"
---
# @deepseek-ai/dsh-client-ui-projection

[English](README.md) | 中文

## 概述

每个 Client row 都以同一方式读取的持久化来源到视图值的折叠：上下文出处与呈现形态、Assistant 块分类与流式累积、inbox 拼接与输入消息记录、Tool 调用记录与子调用图上界、合成 seq 偏移、可安全显示的失败字段、subagent 后代索引，以及一次性 composer 结算适配器。Conversation target 决定从这些值中渲染什么；日志来源如何映射到它们则在此处只有一个归属。

成员规则：只有当一个导出是无状态函数或冻结常量，且不涉及 Cordis API、没有模块状态、也没有调用方会比较的运行时标识时，它才属于本包。正是这一点让 `apps/web` 能静态链接一份副本，并让 shell 将其作为 `PLATFORM_MODULES` 词条播种进冻结的模块表，从而使每个动态 Client bundle 解析到同一个实例，而不是各自携带一份。任何带有生命周期、注册或共享可变状态的东西都应改为放在 Cordis service 上——`uiSession.registerPendingInteraction` 现在拥有它此前与本包共享的 pending-interaction 发布与结算。

本包不对任何 Client row 产生运行时依赖。它仅以 `import type` 从 `@deepseek-ai/dsh-client-ui-conversation/client` 读取 Conversation 记录与匹配类型，因此该边在 emit 前即被擦除，浏览器模块图保持单向。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包只把已记录的 Session 数据投影为浏览器视图值，不注册任何面向模型的内容。

#### KV Cache 影响

无；这些折叠既不组装也不发送模型请求。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- **Conversation 记录类型仍留在 `ui-conversation`**——此处的折叠产出 `AssistantBlock`、`RunningToolCall` 及其同类，但这些声明仍与其他 row 会增广的可合并扩展映射 `ConversationTurnDataMap` / `ConversationStepDataMap` 放在一起。迁移它们会移动每一处 `declare module` 的目标，因此本包以类型导入引用它们，类型图由共享层指向该 row，而非反向。
- **新增导出是一次 shell 变更**——只有当 `PLATFORM_MODULES` 与 `packages/client/web/src/seed.ts` 收录本包后，这里的新名字才可被解析，因此消费方无法仅靠包内构建取用它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

`bun run verify-client-packages` 会检查静态通道的两半：`PLATFORM_MODULES` 词条若归属工作区包，其构建必须走 `staticLinked` preset；动态消费方只能在 `devDependencies` 中声明本包。消费方不需要 `dsh.client.external` 行——该 gate 会拒绝重复声明 baseline 模块。

</details>
