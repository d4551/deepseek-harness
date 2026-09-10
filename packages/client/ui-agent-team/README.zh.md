---
description: "使用并排查 Web Agent Teams roster、共享任务板与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Agent Teams action，用于查看智能体维护的任务、消息与活动，并打开成员会话。它通过生成的 `ctx.remote.agentTeams` contribution 读取权威 Team 状态，子会话历史导航使用 addressed-subagent 路径。Web bundle 在每个 Web profile 中都挂载本包。浏览器视图不存储 Team 状态，也不注册面向模型的输入。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

[`@deepseek-ai/dsh-web-app`](../../bundle/web-app/README.zh.md) 在每个 Web profile 中以 `ui-agent-team` 行挂载本包，位于 [`@deepseek-ai/dsh-base`](../../bundle/base/README.zh.md) 挂载的 Team 服务与工具之上。Web Client loader 挂载 `/client` export；root Host export 不执行行为，本包也没有用户配置字段。

### 检查并导航 roster

打开 panel 会订阅 `agentTeams/changes`，并通过 `agentTeams/overview` 读取初始状态和后续更新。Roster row 展示持久 name、description、运行时 status、model 与 diagnostics。选择健康 teammate 时，系统刷新既有直接 child catalog，并打开普通的 `{ parentSessionId, childSessionId, mode: 'continuable' }` address。History 与后续人类 prompt 继续使用稳定 addressed-subagent 会话路径；本包不会添加 Team 专用 address 字段。

消息位于主面板，显示发送者、接收者、保留段落的内容以及待送达或已送达状态。已注册工作区成员的回复与发出的消息一起按日志事件时间排列。独立的 `agentTeams/conversations` 读取会列出嵌套子智能体及其直接父会话和活动状态。历史记录加载或失败时，消息与任务仍可使用；刷新会话会重试目录读取。选择后代会话会打开其精确的父子地址；Lead 行可返回根会话。

### 跟踪智能体维护的工作

任务板显示智能体管理的工作、负责人、依赖、可执行状态、写入范围和重叠警告。其他运行中会话的任务板来自已注册的工作区成员关系，并随 Team 活动更新。智能体会在协调指引中收到这些任务板，通过 Team 工具维护任务和交接。面板没有任务录入、分配或编辑控件，只显示已提交的任务状态；成员空闲不代表任务已经完成。

按 Escape、点击关闭或点击面板外部可关闭面板；Escape 与关闭按钮会将焦点返回触发按钮。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 挂载来自 [`@deepseek-ai/dsh-agent-team/remote`](../../subagent/agent-team/README.zh.md) 的生成式 `ctx.remote.agentTeams` contribution，然后通过 Cordis effect 注册 locale dictionary 与一个 conversation-header slot。Dispose plugin fiber 会移除这两项 registration。

每次发布 overview 后都会刷新后代会话目录。目录读取失败时提供独立重试操作，任务与消息仍可查看。

实时订阅会在 view 读取尚未完成时合并活动通知。关闭 panel、切换会话或卸载会取消订阅，并使未完成的读取失效。流中断时会显示错误；重新打开 panel 会建立新订阅并读取当前状态。

共享的工作区尺寸 Modal 与 PanelLayout 组件提供行对齐的响应式布局与视口内滚动。共享按钮、标签、消息正文与活动状态点构成面板控件，无需面板样式表或行内样式。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 生成式 Remote、locale、导航与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster 与任务板交互状态 |
| [`src/client/TaskCard.tsx`](src/client/TaskCard.tsx) | 智能体维护的任务进展、负责人和依赖 |
| [`src/client/TeamMessages.tsx`](src/client/TeamMessages.tsx) | 持久的智能体间消息与送达状态 |
| [`src/client/TeamConversations.tsx`](src/client/TeamConversations.tsx) | 实时后代会话目录与导航 |
| [`src/client/observe-team.ts`](src/client/observe-team.ts) | 有界活动消费与订阅取消 |
| [`src/client/locales.ts`](src/client/locales.ts) | 中英文 panel 文案 |
| [`src/index.ts`](src/index.ts) | 不执行行为的 Host entry |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Web bundle](../../bundle/web-app/README.zh.md)——挂载本 Client plugin 的随发布 bundle。
- [Agent Teams service](../../subagent/agent-team/README.zh.md)——权威 roster、task 与 Remote 行为。
- [会话 UI](../ui-conversation/README.zh.md)——稳定 header slot 与 addressed-subagent 导航表层。

-----

<a id="model-experience"></a>
## 模型体验

无直接影响，因为该浏览器视图不注册面向模型的输入。

#### KV Cache 影响

无直接影响；Team 工具与普通会话提交负责后续任何模型可见用途。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **普通 child continuation**——导航后发送的人类消息使用稳定 addressed-subagent prompt 路径，而不是 Team peer mailbox。
- **没有 lifecycle 或 workspace control**——panel 不能 spawn、rename、delete 或 interrupt teammate，write scope 仍只是提示性 metadata。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
