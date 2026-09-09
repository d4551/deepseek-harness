---
description: "使用并排查 Web Agent Teams roster、共享任务板与 teammate 导航面板。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-agent-team

[English](README.md) | 中文

## 概述

本包向 Web 会话页头添加 Agent Teams action，让用户检查当前 roster、管理共享任务板并导航到 teammate 会话。它通过生成的 `ctx.remote.agentTeams` contribution 读取权威 Team 状态，并让普通 child history 导航继续使用稳定的 addressed-subagent 路径。Web bundle 在每个 Web profile 中都挂载本包，位于每个 profile 的 base 所挂载的 Team 之上。这个浏览器 projection 不扩展稳定 API Proxy、不存储 Team 状态，也不注册面向模型的输入。

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

### 管理任务板

任务板按任务分组展示 task identity、owner、blocker、readiness、提示性 write scope 与重叠 warning。用户可以通过 `agentTeams/createTask` 与 `agentTeams/updateTask` 创建、编辑、分配或取消分配、完成、重开和删除任务。不可用的 owner 仍显示在负责人选择框中。编辑会保留用户打开表单时的 revision，实时更新不会自动推进该版本。发生冲突后，草稿仍可供复制；取消并重新打开编辑器，检查最新任务后再编辑。Create 或 update rejection 都保留为显式 business result。

打开任务表单时，焦点移至任务标题。表单在输入后保留可见字段标签，并支持在单行字段中按 Enter 提交。保存期间会禁用输入与操作。按 Escape、点击关闭或点击面板外部可关闭面板；Escape 与关闭按钮会将焦点返回触发按钮。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

Client export 挂载来自 [`@deepseek-ai/dsh-agent-team/remote`](../../subagent/agent-team/README.zh.md) 的生成式 `ctx.remote.agentTeams` contribution，然后通过 Cordis effect 注册 locale dictionary 与一个 conversation-header slot。Dispose plugin fiber 会移除这两项 registration。

开始 create 或 update 会让更早的 refresh 失效。成功后会重新读取 Team overview，使每个 task 的派生字段保持最新。`team-task-conflict` 结果仅在重新读取成功后显示状态陈旧提示；如果重新读取失败，则保留该错误。由于 Team service 把任务文本或 scope 编辑与 dependency 修改公开为独立 action，两者使用两个连续的 compare-and-set mutation。

实时订阅会在 view 读取尚未完成时合并活动通知。关闭 panel、切换会话或卸载会取消订阅，并使未完成的读取失效。流中断时会显示错误；重新打开 panel 会建立新订阅并读取当前状态。

共享的工作区尺寸 Modal 与 PanelLayout 组件提供响应式分栏与视口内滚动。共享按钮、输入框、标签、消息正文与活动状态点构成面板控件，无需面板样式表或行内样式。

| 文件 | 职责 |
|---|---|
| [`src/client/mount.ts`](src/client/mount.ts) | 生成式 Remote、locale、导航与 slot registration |
| [`src/client/TeamAction.tsx`](src/client/TeamAction.tsx) | Roster 与任务板交互状态 |
| [`src/client/TaskForm.tsx`](src/client/TaskForm.tsx) | 通过共享输入与按钮组件编辑带标签的任务字段 |
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

无直接影响，因为该浏览器 projection 与任务控制界面不注册面向模型的输入。

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
