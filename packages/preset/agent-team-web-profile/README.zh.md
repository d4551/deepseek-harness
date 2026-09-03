---
description: "swarm-web profile 的浏览器层：一行 patch，渲染 Agent Teams roster、任务板与信箱。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-agent-team-web-profile

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-agent-team-web-profile` 是内置 `swarm-web` profile 的浏览器层。它只携带一行 patch，而正是这一行让 [Agent Teams](../../subagent/agent-team/README.zh.md) 可见：对话标题栏会获得 Team roster、共享任务板与 teammate 导航。Host Team 层提供 domain；本 bundle 提供人能看见它的唯一界面，因此缺少它的 swarm 完全无从观察。

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

### 启动内置 profile

```sh
dsh --profile swarm-web
```

`swarm-web` 按顺序叠加 `dsh-base`、`dsh-web-app`、[`dsh-swarm-profile`](../swarm-profile/README.zh.md) 与本包。该 profile 与其他内置模板一样在首次使用时自动初始化，浏览器打开的会话中，其 Agent 已经是 Team Lead。

### 添加到自己的 profile

```sh
bun run dsh plugin --profile web add ./packages/preset/agent-team-profile
bun run dsh plugin --profile web add ./packages/preset/agent-team-web-profile
```

第一条命令只在 `dsh-base` 之上提供 Team domain、生成的 Remote 方法与模型工具；第二条命令激活本包声明的 patch 及其浏览器 presentation。执行 `dsh plugin --profile web remove @deepseek-ai/dsh-agent-team-web-profile` 会把 Web 层从 profile 的有序 bundle 列表中移除。

### 获得的功能

对话标题栏会获得 Team roster、共享任务板与 teammate 导航。[`@deepseek-ai/dsh-client-ui-agent-team`](../../client/ui-agent-team/README.zh.md) 负责这些浏览器交互，并挂载用于访问 Host Team service 的生成 Client Remote namespace。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包的运行时内容是 [`cordis.patch.yml`](cordis.patch.yml)。在 `dsh-web-app` 与 Host Agent Teams 层之后应用时，它唯一的 `insert` 条目会为 `@deepseek-ai/dsh-client-ui-agent-team` 添加 `ui-agent-team` 行。插入的 Client 插件负责生成的 Remote assembly 与 Team UI；这个静态 bundle 不持有可变状态，也不安装运行时不变式。

Team 工具注册在每个 Agent 自身的 scope 中。在工具注册表里较近的 scope 会遮蔽较远的 scope，因此对每个 Team 成员来说，Web Agent preset 中同名的 continuable child 控制项（`list_agents`、`send_message`、`interrupt_agent`）都会被 Team scope 的工具遮蔽，组合本层无需 Team-aware preset。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 包含 `ui-agent-team` 行的有序 Web patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 是运行时内容 |
| [`src/invariant.ts`](src/invariant.ts) | 静态 bundle 的空不变式伴生插件 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Swarm profile bundle](../swarm-profile/README.zh.md)——`swarm-web` 叠在本层之下的 Host 层。
- [Agent Teams Host profile](../agent-team-profile/README.zh.md)——仅在 `dsh-base` 之上提供同一 domain，供自建 profile 使用。
- [Agent Teams 浏览器 UI](../../client/ui-agent-team/README.zh.md)——roster、任务板与 teammate 导航行为。
- [Web bundle](../../bundle/web-app/README.zh.md)——本 patch 扩展的浏览器层。

-----

<a id="model-experience"></a>
## 模型体验

通过本 Web 层之下选择的 Host-side swarm 层间接产生影响。

#### KV Cache 影响

本 Web bundle 不添加任何模型请求内容；Host-side Team 工具负责提示词、schema 与缓存影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **有序组合**——`dsh-base`、`dsh-web-app`、Host Team 层与本包必须保持这个顺序。把本行插入到 Host 层之前，会挂载一个 Remote namespace 无 Host 属主的浏览器插件。
- **只读 Lead 的 Team**——面板读取会话 Lead 的 Team。打开 teammate 会话会导航到该子会话；那里的面板仍显示 Lead 的 Team，因为那正是该 teammate 所属的 Team。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
