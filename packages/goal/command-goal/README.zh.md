---
description: "面向在 UI 命令平面中选择、组合或排查 goal 控制的用户与维护者的 /goal 斜杠命令说明。"
kind: "package-reference"
---

# @deepseek-ai/dsh-command-goal

[English](README.md) | 中文

## 概述

`dsh-command-goal` 为用户提供基于持久 goal 服务的 `/goal` 命令：用户可以直接在 UI 中创建、编辑、暂停、恢复、清除并查看当前 goal。命令在其 Cordis scope 中注册，读取该 scope 的命令适配器能发现并执行它。每项被接受的变更都会通过持久 `goal/change` 事件落盘。成功的 create、edit 和 resume 还会将用户指令排入下一个 goal 步骤；已准入的图片附在同一条消息中。状态、暂停、清除和错误输出留在 UI 中。为挂载了命令适配器的交互式部署选择它；没有适配器的无头与自动化应用不需要它。

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

在挂载了命令适配器的交互式部署中使用 `dsh-command-goal`——随附的 Web 客户端是参考实现。它让用户无需模型轮次即可直接控制 goal 生命周期：命令在 UI 命令平面执行，适配器直接渲染其结果。

### 命令参考

每个子命令都针对调用 agent 的当前 goal 执行；没有 goal 时，裸 `/goal` 显示用法。

| 输入 | 结果 |
|---|---|
| `/goal` | 显示当前目标、持久 phase、Round 数量与上限、进程本地续行启用状态与有效的下一步命令；被阻塞的 goal 还会显示其策略代码与说明 |
| `/goal <objective>` | 创建 goal 并启用续行，或用全新身份替换已完成 goal |
| `/goal edit <objective>` | 编辑当前目标，不改变其 phase 或续行启用状态 |
| `/goal pause` | 暂停 active goal 并停用续行 |
| `/goal resume` | 恢复已停止 goal，或在会话 resume 或 fork 后重新启用 active goal；仍受剩余 Round 上限约束 |
| `/goal clear` | 清除当前 goal，同时保留其持久历史 |

### 输入语法

只有控制词（`clear`、`pause`、`resume`、`edit`）占据完整输入时才被识别；其他任何非空后缀都是目标，因此 `/goal pause after verification` 会创建该字面目标。`edit` 内联接收替换内容，并拒绝直接替换未完成的 goal。可预期的领域拒绝会变成稳定的直接命令错误，不暴露带品牌类型的 id 或 revision；意外实现失败仍会让分发失败，使适配器能将其报告为命令失败。

### 图片附件

`/goal` 声明了图片支持。附件只随目标本身：create 或 edit 成功时，一条用户消息携带已准入的图片块和完整命令文本，排入 `next-step`，但不会唤醒 agent。goal 驱动器提供轮次提示词并唤醒 agent，两条输入进入同一个模型步骤。暂停状态下的 edit 会等待后续唤醒。其他子命令拒绝图片，被拒绝的变更不提交工作消息，分发方 composer 保留图片。

### 组合方式

命令注入命令注册表与 goal 服务。自定义应用会挂载它们的所有者与此插件；自动续行仍是独立选择：

```yaml
- id: commands
  name: '@deepseek-ai/dsh-commands'
- id: goal
  name: '@deepseek-ai/dsh-goal'
- id: command-goal
  name: '@deepseek-ai/dsh-command-goal'
```

随附的 `dsh` 基础配置启用持久 goal 栈与此命令。Web bundle 把 goal 服务与 driver 保留在 Host，禁用基础命令 producer，并在 `standard`、`code` 和 `cordis` agent preset 中挂载 producer；`minimal` 会省略它。ACP（Agent Client Protocol）自动化应用启用领域与模型工具，但不挂载命令适配器。无 UI 的 `agent-spine-demo` 必须显式配置 `goals: {}`，避免无头单次调用方在不知情时从一个物理轮次变为包含多个 Round 的操作。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释命令如何解析输入并渲染输出；可观察约定已在[使用本包](#use-this-package)中说明。

### 设计

- **语法，而非自由文本。** 解析器只在控制词（`clear`、`pause`、`resume`、`edit`）填满整个输入时识别它们；其他任何非空后缀都是目标。单独的 `edit` 无效，且 `edit` 拒绝直接替换未完成的 goal。
- **领域拒绝变成稳定错误。** `GoalError` 结果会转换为带固定消息的直接命令错误；意外失败会重新抛出，使适配器报告命令失败而非领域结果。渲染输出绝不暴露带品牌类型的 id 或 revision。
- **用户指令加入 goal 步骤。** 成功的 create、edit 和 resume 将完整命令作为用户输入排队，不主动唤醒驱动器。create 和 edit 同时携带已准入的图片。goal 驱动器在下一轮领取这些输入；部署策略可以验证实时用户提交并持久记录对应模型请求。被拒绝的命令不发布工作输入。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：命令语法、状态渲染、附件提交 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生：空（无运行时不变式——已接受的变更由 goal 领域负责） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

该命令是 goal 领域的薄适配器；需要了解它变更的状态与它接入的注册表时阅读以下页面。

- [goal 服务](../goal/README.zh.md)——命令变更的状态与生命周期。
- [命令服务](../../interaction/commands/README.zh.md)——命令注册表约定与分发。
- [用户 goal 命令 Agent Note](../../../.agents/notes/implemented/feature/2026-07-19-human-goal-command.zh.md)——用户体验与组合决策。

-----

<a id="model-experience"></a>
## 模型体验

### 用户 `/goal` 控制

#### 模型看到的内容

goal 领域把变更记录为 `goal/change`。成功的 create、edit 和 resume 还提供一条普通用户消息，包含完整命令文本；create 和 edit 的图片块位于文本之前。该消息加入 goal 驱动器的下一个步骤。状态、暂停、清除和直接错误输出不增加模型消息。

#### Token 影响

读取状态、暂停、清除或收到直接命令错误不会增加模型 token。成功的 create、edit 和 resume 指令进入普通请求历史，图片随该用户消息计费。排入这条输入不会单独产生模型请求。

#### KV Cache 影响

命令发现与直接输出不影响缓存。被接受的用户指令和后续轮次提示词追加到普通请求历史，系统策略保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明命令何时不合适或需要特别注意。它们是当前包约束，不是任务积压。

- **仅纯文本交互**——通用命令注册表没有模态编辑表单或替换确认回调；内联 edit 与显式 clear 能在不同适配器中保持明确且一致的破坏性意图。
- **没有逐命令 Round 上限参数**——`defaultMaxGoalRounds` 仍是部署配置；用户直接请求时，可以要求模型通过另行授权的 goal 工具编辑 `max_goal_rounds`。
- **没有持续状态组件**——裸 `/goal` 是可移植的观察接口；不提供适配器专用徽标或重连后可恢复的命令输出。
- **随附应用中只有 Web 命令适配器使用此命令**——无头、ACP 自动化和 JSON-RPC 适配器不消费 `ctx.commands`。如果组合中包含面向模型的 goal 工具，普通提示词仍能授权它们。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文，明确不具权威性。开放且未决：持续状态组件与逐命令 Round 上限输入；两者都是延后的 UI 与配置工作。

</details>
