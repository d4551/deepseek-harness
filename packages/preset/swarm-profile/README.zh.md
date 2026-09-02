---
description: "叠加在 dsh-base 之上的私有 swarm profile 层：多个队友同时处理同一个请求，从共享任务板自行领取工作，并受有界的一次性 run 上限约束。"
kind: "package-bundle"
---

# @deepseek-ai/dsh-swarm-profile

[English](README.md) | 中文

## 概要

`@deepseek-ai/dsh-swarm-profile` 是一个私有 profile 层，在 `@deepseek-ai/dsh-base` 之上把 [Agent Teams](../../subagent/agent-team/README.zh.md) 变成 swarm 模式。Lead 先把请求拆成带写作用域和依赖的共享任务，再创建队友；每个队友用 `team_task_claim_next` 自行领取工作，而不是等待被指派。该 patch 同时为 Subagent 缝设定并发一次性 run 的上限，因此扇出前台委派的 swarm 会排队，而不会让宿主超载。请在初始化过的源码检出 profile 中显式添加它；正式发布不包含本包。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

### 安装到 profile

在本仓库检出中，把本包加入一个已初始化的 profile，然后运行一个足够大、值得拆分的任务：

```sh
bun run dsh plugin --profile headless add ./packages/preset/swarm-profile
bun run dsh --profile headless "Split this refactor across a swarm and report when the board is empty."
```

该 profile 必须已经包含 `@deepseek-ai/dsh-base`，本层要消费它提供的 Subagent 服务与 provider 行。用 `dsh plugin --profile <name> remove @deepseek-ai/dsh-swarm-profile` 移除本包，会把该 bundle 从 profile 的有序层列表中去掉。

### 你会得到什么

本层加入 Agent Teams 域及其作用域内的工具，并设置 `coordination: swarm`，从而以拉取式指引取代委派式策略。它禁用工具名与 Team 控制重叠的全局可续子 Agent 控制行，保留 `subagent` 与 `subagent_fork` 作为一次性委派工具，并为 `ctx.subagents` 设定 `maxConcurrentRuns` 上限。

### 调整 run 上限

`subagent` 行上的 `maxConcurrentRuns` 表示该部署同时可以有多少个已发布的一次性子 run；超出上限的启动按到达顺序排队，并在更早的 run 结算或被释放后立即派发。队友是可续子 Agent，不计入该上限：一个 Activation 会在整个对话期间常驻，把它计入会让前台委派被长期存在的成员堵住。宿主容量更大时调高该值，多个 swarm 共用一台机器时调低。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本包的运行时内容就是 [`cordis.patch.yml`](cordis.patch.yml)。它在 `dsh-base` 之后应用：为 `subagent` 行设定上限，禁用 `tool-subagent-control`、`tool-subagent-list-agents` 与 `tool-subagent-report`，把 fresh 与 fork 两个 Subagent 行设为 `one-shot`，并插入带显式 provider、限额与 swarm 协作模式的 Team 服务行与工具行。

| 文件 | 职责 |
|---|---|
| [`cordis.patch.yml`](cordis.patch.yml) | 叠加在 `dsh-base` 之上的有序 patch |
| [`src/index.ts`](src/index.ts) | 空模块入口；patch 才是运行时内容 |
| [`src/invariant.ts`](src/invariant.ts) | 静态 bundle 的空不变量伴生插件 |

本包自己的测试会用真实 Loader 启动该 patch 插入的行，并断言由此得到的组合：`ctx.subagents` 上配置的 run 上限、装配后的工具 schema 中的 `team_task_claim_next`，以及渲染后提示词中的 swarm 指引。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Agent Teams 服务](../../subagent/agent-team/README.zh.md) —— 持久化名册、消息与任务板行为，包括原子领取。
- [Agent Teams 工具](../../subagent/tool-agent-team/README.zh.md) —— Team 作用域内的模型工具面及其协作模式。
- [Subagent 缝](../../subagent/subagent/README.zh.md) —— 本 patch 配置的 run 上限。
- [Base bundle](../../bundle/base/README.zh.md) —— 本 patch 扩展的 profile 层。

-----

<a id="model-experience"></a>
## 模型体验

### swarm 策略与工具

#### 模型看到什么

策略文本与工具 schema 属于 [`@deepseek-ai/dsh-tool-agent-team`](../../subagent/tool-agent-team/README.zh.md)。本 bundle 选择 swarm 策略：Lead 被要求先拆成带写作用域的任务再创建队友；每个成员被要求用 `team_task_claim_next` 领取工作，并把 `none` 结果读作普通的任务板状态而不是失败。Team 作用域的 `list_agents`、`send_message` 与 `interrupt_agent` 取代被禁用的全局可续子 Agent 控制。

#### Token 影响

本 bundle 加入 `dsh-tool-agent-team` 描述的 swarm 策略段落与 Team 工具 schema；它自身不加入任何提示词文本。

#### KV Cache 影响

只要 patch、Team 身份与已配置的工具 schema 不变，本 bundle 的组合就是前缀稳定的。排队的一次性启动只影响延迟，不改写任何提示词前缀。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **仅限源码检出** —— 该私有包不出现在正式的 npm、CLI、Web 或 Python 发布产物中。
- **共享检出目录** —— 每个队友看到同一个工作目录；写作用域是建议性的任务元数据，不是文件系统锁，本 bundle 也不提供 worktree 隔离。
- **需要 base profile** —— 该 patch 依赖 `dsh-base` 提供的行 id 与 Subagent provider，它不是独立 profile。
- **每个部署只有一个上限** —— `maxConcurrentRuns` 约束整个进程，没有按 Team 或按成员的子配额。

<a id="dev-note"></a>
### 开发者备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
