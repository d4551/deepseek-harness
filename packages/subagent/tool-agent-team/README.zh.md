---
description: "十一个让模型创建、发消息与协调 teammate 的工具，供组合 Team 插件的部署方阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-agent-team

[English](README.md) | 中文

## 概述

`@deepseek-ai/dsh-tool-agent-team` 提供十一个 scoped 工具，用于创建 teammate、交换消息、检查进展与管理共享任务板。默认的 `delegated` 策略要求用户明确请求团队。`swarm` 策略让 Lead 创建任务和 teammate，由成员领取就绪工作。两种策略都协调共享工作区中的编辑。本包以 prerelease 形式发布，不承诺稳定性。

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

当模型应该通过工具运行一支团队时，在 `@deepseek-ai/dsh-agent-team` 之上挂载本包。挂载后，每个团队成员——Lead 与每个 teammate——都会获得相同的十一个工具，外加一段说明自身角色与名字的策略段落。

### 何时选择

当模型应该创建与协调 teammate 时，选择它。Team 作用域内的工具优先于同名全局工具。需要明确的委派请求时选择 `delegated`；通过任务板分配工作时选择 `swarm`。

### 最小工作示例

对现有组合的最小增量是 [agent-team README](../agent-team/README.zh.md#smallest-working-setup) 中的两包片段：持久会话存储、团队领域包与本包。插件本身只有四个可选设置：

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `freshProvider` | 自动发现 | 唯一已注册且可启动 fresh teammate 的 continuation provider |
| `forkProvider` | 自动发现 | 唯一已注册且可继承 Lead 上下文的 continuation provider |
| `coordination` | `delegated` | 成员收到的指引：`delegated` 或 `swarm` |
| `excludePresets` | `[]` | 其 Agent 保持 preset 自身精确工具集、不接收 Team 工具的 agent preset id |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-agent-team)是每个受支持字段及其 JSDoc 的穷尽式真源。

如果每种请求的上下文模式都恰好有一个已注册 provider 支持，可以省略 provider 设置。多个 provider 匹配时，必须明确指定。provider 缺失或上下文不匹配会在保留 teammate 名字或占用容量之前拒绝创建。

设置 `coordination: swarm` 后，Lead 将工作拆分为共享任务，teammate 通过 `team_task_claim_next` 领取就绪任务。挂载命令注册表时，`/swarm <request>` 会将新请求提交到 Lead 的普通轮次队列。请求必须包含文本，也可以附带图片。委派组合、排除的 preset 和 teammate 作用域中没有此命令。

两种策略都要求 Lead 在创建 teammate 前建立任务记录，并要求成员领取、完成和报告分配的工作。Swarm 指引保留用户对具名 teammate 的明确分工；未分配的工作使用原子的下一任务领取。创建成员不会自动建立任务记录。每次组装提示词都包含本团队的当前任务板和其他工作区会话的任务板。

试试这样要求 Lead 模型：「创建一个名为 reviewer 的 teammate 检查 diff，再把变更摘要发给 reviewer」。模型会调用创建工具，然后调用消息工具。

### 模型能做什么

十一个工具分为四类能力：

- **创建 teammate**——`spawn_teammate` 接收名字、描述与初始任务；只有 Lead 可以调用它。
- **发送消息**——`send_message` 在不唤醒 idle teammate 的情况下传达信息；`followup_task` 让消息成为接收方的下一个轮次，并在需要时唤醒它。
- **查看与等待**——`list_agents` 显示带实时状态的 roster；`wait_agent` 等待下一次团队变化；`interrupt_agent` 停止 teammate 的当前轮次（仅限 Lead）。
- **管理任务板**——`team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update` 添加、浏览、读取与更新共享任务。`team_task_claim_next` 领取下一个就绪任务，避免与进行中任务的写入范围重叠。

任何成员都可以给任何其他成员发消息并使用任务板；只有 Lead 可以创建与中断 teammate。任务更新保留领域的 owner 与 revision 校验，因此过期的编辑会被拒绝，而不是覆盖更新的成果。

### 成功与失败的表现

发送消息在安全存储后即成功：结果为 `accepted`（已送达）或 `queued`（等待中），排队的消息绝不能重发。当没有其他成员 running 或 provisioning 时，`wait_agent` 会立即返回 `noProgress`，提示调用方先唤醒 teammate；否则它会等待下一次变化，调用方随后重新读取状态。基于过期 revision 的任务编辑会被拒绝，而不是覆盖更新的成果。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具插件背后的设计决策并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

工具插件建立在三项承诺之上：

- **按作用域，而非全局。** 每个注册都位于成员 Agent 自己的 `ctx` 上；非 Team subagent 或宿主不会安装任何内容。
- **声明式结果，紧凑 JSON。** 每个工具都声明完整结果 schema，并把该值渲染为紧凑 JSON，因此编译器会对照模型被承诺的值检查 `execute`，任何结果都不会在缩进上消耗 token。
- **领域拥有权限。** 每个工具直接调用 `ctx.agentTeams`，后者强制执行 Lead 权限与 revision 校验；本包不添加更弱的路径。

[Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)负责模型侧与 scoping 决策。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：配置、协作策略与十一个 scoped 工具注册 |
| [`src/swarm-command.ts`](src/swarm-command.ts) | 通过命令注册表提交 Lead 作用域内的请求 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；委托只能通过 `ctx.agentTeams` 观察） |

### 策略与工具

一个 `team:policy` 段落教每个成员自己的角色与配置的协作规则。策略文本与十一个工具注册声明在 [`src/index.ts`](src/index.ts)。工具 schema 只出现在 Team member scope 中，并优先于同名全局工具。

### 按作用域注册与拆除

`maybeInstall` 对每个 live Agent 运行，并订阅 `agent/created`；它跳过没有 Team 成员关系的 Agent。Agent dispose 会运行已安装的 disposer，插件 HMR 会在重新安装前处置每个已安装的 scope。每个 disposer 按逆序展开注册，因此失败的安装不会留下残缺 scope。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从领域服务逐步进入精确 schema 与设计背后的决策。

- [agent-team 包](../agent-team/README.zh.md)——这些工具背后的 `ctx.agentTeams` 领域服务。
- [Agent Teams 子系统](../../../docs/subsystems/agent-team.zh.md)——持久 Team 类型与服务 API。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-agent-team)——模型接收的每个工具 schema。
- [Agent Teams Agent Note](../../../.agents/notes/implemented/feature/2026-08-05-agent-teams.zh.md)——模型侧、scoping 与隔离决策。

-----

<a id="model-experience"></a>
## 模型体验

### Team 策略与工具

#### 模型看到什么

一段策略会说明 Team role／name／id、配置的协作策略、共享 cwd 行为、文件 stale-version 恢复、Bash／formatter／codegen 风险、task／write-scope 协调、quiet 与 waking 投递区别、mailbox 不重试规则，以及 Lead 必须在回答前等待。`spawn_teammate` 到 `team_task_update` 的十一个 Team schema 只出现在 Team member scope。

#### Token 影响

每次 Team member 请求都包含策略、schema 和当前 roster 与任务板快照。快照大小随团队和工作区任务板增长。工具调用会增加紧凑 JSON roster、task、wait 或 receipt 结果。Peer 内容由 Team 领域保留在 target 历史中。

#### KV Cache 影响

Team 插件 generation 与配置不变时，策略和 schema 前缀保持稳定。身份因成员而异；roster 和任务板文本随已提交状态变化。工具结果与 peer 消息追加到会话历史。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明策略与工具无法为一支团队保证什么。它们是当前包约束，不是与其他协作表面的对比。

- **提示词策略只负责协调，不负责 confinement**——它无法阻止 Bash 或外部进程写入重叠文件。
- **委派遵循配置策略**——`delegated` 要求用户明确请求团队；`swarm` 指示 Lead 创建任务与 teammate 来并行工作。
- **没有 Web 控制功能**——浏览器 roster 与任务板呈现不属于该运行时包。
- **Prerelease，无稳定性承诺**——本包以 `0.x` alpha 发布，schema 仍可自由变更。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
