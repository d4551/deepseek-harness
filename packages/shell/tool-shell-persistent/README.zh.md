---
description: "面向模型的持久 shell 工具，供选择、配置或排查跨调用保留的按所有者隔离 bash 或 PowerShell 状态的使用者与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-shell-persistent

[English](README.md) | 中文

## 概述

`dsh-tool-shell-persistent` 为 agent 提供一个 shell 工具，其状态对拥有它的 agent 跨调用保留：cwd、导出的或 `$env:` 变量、函数与后台任务都会在命令之间存活。必填的 `dialect` 配置决定该次挂载驱动哪种 shell——`bash` 注册 `bash` 工具，`pwsh` 注册 `pwsh` 工具——并随之决定命令包装、引用方式、提示词处理与默认描述。每个 agent 都有自己由 terminal 服务的按所有者隔离 PTY 会话支撑的 shell，同一 agent 的命令逐个串行执行。配置还选择 PTY 后端与单条命令的墙钟上限；超时或显式 `exit` 会关闭 shell，下一次调用从全新状态开始。它补充一次性 `dsh-tool-shell` 工具——当工作依赖跨调用状态时选择它。请与方言匹配的 terminal 后端（例如 `dsh-terminal-bash`）以及 `ctx.terminals` 服务一起挂载。

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

在 agent 需要在命令之间保持 shell 状态的任何组合中加载本插件——例如长时间构建会话、已激活的环境，或为后续步骤导出变量的脚本。它注册由 `dialect` 命名的工具，需要 `ctx.tools` 与 `ctx.terminals` 服务，并在执行时需要拥有者 agent 会话。

### 何时选择

当工作依赖跨调用状态时选择持久工具：一次性 `dsh-tool-shell` 调用无法记住 `cd` 或导出的变量。当每条命令都应从已知、干净的环境开始，或命令又短又独立时，选择一次性工具。这里不支持需要交互 stdin 的命令——读取输入的前台子进程会一直阻塞到命令超时——因此交互工作属于 terminal 工具。

### 选择方言

`dialect` 没有默认值：请显式声明，并声明 PTY 后端实际启动的那种 shell。方言决定工具名、包裹命令并报告其状态的 wrapper，以及（对 pwsh 而言）本工具覆盖后端提示词所安装的私有提示词。在 pwsh 后端上挂 bash 方言，会把 bash wrapper 语法提交给 PowerShell，并永远看不到完成标记。每个组合只挂载一次本插件。

### 最小配置

默认的 `shell` 后端通过 `dsh-terminal-bash` 启动交互式 bash；部署方可以注册其他 PTY 后端并按名称选择。

```yaml
- name: '@deepseek-ai/dsh-terminal'
- name: '@deepseek-ai/dsh-terminal-bash'
- name: '@deepseek-ai/dsh-tool-shell-persistent'
  config:
    dialect: bash
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `dialect` | 必填 | `bash` 或 `pwsh`：工具名、命令包装、提示词处理与默认描述 |
| `backendType` | `shell` | 用于每个 agent shell 的已注册 PTY 后端 |
| `timeoutMs` | `300,000` | 单条命令的墙钟上限；超时关闭 shell |
| `maxOutputChars` | `16,000` | 保留的命令输出字符上限；固定诊断信息在其后追加 |
| `description` | 所选方言的默认值 | 面向模型的环境约定；部署方可描述自己的环境 |

两种方言的默认描述分别是 `Run commands in a persistent bash shell. State, including the current directory and exported environment variables, persists across calls for this agent.` 与 `Run commands in a persistent PowerShell shell. State, including the current directory and exported environment variables, persists across calls for this agent.`

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-shell-persistent)是每个受支持字段及其 JSDoc 的穷尽式真源。

### agent 可以依赖什么

命令共享每个 agent 一个 shell，因此状态一直保留到 `exit`、超时或重置——每一种都会关闭 shell 并告诉 agent 下一次调用从工作区的新目录与环境开始。结果排除私有完成标记；非零的包装命令追加 `[exit code: N]`，而在报告该状态前就退出的 shell 改为追加 `[shell exited: code N]`、`[shell killed by signal: SIG]` 或 `[shell exited]`，然后重置。长输出保留最早的已保留前缀并附裁剪通知；若 terminal 已经丢弃该前缀，结果会明确说明，而不是把尾部当作完整输出呈现。

### 可能出什么问题

没有拥有者 agent 会话的调用会以 `<dialect> requires an owning agent session` 失败，未声明 `dialect` 的挂载会在加载时的配置校验中失败，没有 PTY 后端的组合会激活该工具，但首次调用以 `no PTY backend registered for "shell"` 失败。交互式前台子进程（例如 REPL）只有在后端证明其 stdin 等待时才提前返回部分输出；否则调用一直运行到 `timeoutMs`，随后关闭不确定的 shell 并报告重置。取消也会重置并丢弃结果，即使完整状态标记已经可观察。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释工具背后的设计决策，并指出实现它们的代码位置；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

- **每个 owner 一个 shell，互不共享。** shell 注册表按调用方 `Agent` 为每个会话建键，因此并发 agent 永不共享状态，同一 agent 的命令通过按 owner 的队列串行化。
- **标记锚定提取。** 每条命令都用携带退出状态的唯一起止标记包装；工具轮询 PTY scrollback 并提取真实标记之间的区间，因此提示词与回显输入永不泄漏进结果。wrapper 带有本次调用自己的 nonce，因此捕获文本中出现的任何 wrapper 都是本次调用的回显，会被剥除。
- **一份实现，一份方言记录。** 会话注册表、轮询循环、scrollback 组装、捕获渲染与重置约定只有一份定义；[`src/dialect.ts`](src/dialect.ts) 保存唯一的按 shell 区分的事实（[每个角色一个 shell 工具 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-03-one-shell-tool-per-role.zh.md)）。
- **重置，而非修复。** 任何不确定状态——显式 `exit`、超时、发送失败、中止——都会关闭 shell 并让下一次调用从全新状态开始，因为半知情的 shell 不如干净的 shell。
- **按 owner 的生命周期。** shell 在首次使用时惰性创建，在插件释放或 owner 拆除时终止；按所有者隔离的 `ctx.terminals` 服务把每个操作都围栏到拥有它的 agent。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：shell 注册表、scrollback 轮询、提取与渲染 |
| [`src/dialect.ts`](src/dialect.ts) | 按 shell 区分的事实：工具名、标记名、wrapper 与引用方式、初始化输入、提示词、完成判定、模型侧文本 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；shell 复用可通过工具执行观察） |

### 命令流程

首条命令通过 `ctx.terminals.spawn` 生成 shell，提交方言的初始化输入并等待就绪：bash 禁用输入回显（`stty -echo`）并保留后端自己的提示词，pwsh 则安装私有提示词，因为 PSReadLine 没有等价的回显开关。随后每条命令都包装成一行物理文本——bash 是 printf 起始标记、用 `$'…'` 转义的命令体、printf 结束标记加 `$?`；pwsh 是 `Write-Output` 起始标记、`Invoke-Expression` 反引号转义的命令体、`Write-Output` 结束标记加解析后的 `$LASTEXITCODE`——因此内嵌换行无法把终端提示词泄漏进结果。工具以 1,000 行一页轮询 scrollback，直到出现结束标记，提取区间并连同任何状态标记一起渲染。若结束标记始终未到，由方言判定命令已结算：bash 依据后端的 `stdin_read` 等待原因，pwsh 依据视口中重新出现的自有提示词。超时会中止截止时间、捕获部分输出并重置 shell。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从 terminal 家族逐步进入 seam、后端，以及按所有者会话背后的设计笔记。

- [terminal 包映射](../../terminal/README.zh.md)——持久 PTY 能力家族。
- [terminal seam](../../terminal/terminal/README.zh.md)——工具背后的 `ctx.terminals` 服务。
- [terminal-bash 后端](../../terminal/terminal-bash/README.zh.md)——默认的 `shell` 后端，也通过其 `shellDialect` 配置服务 pwsh 方言。
- [每个角色一个 shell 工具 Agent Note](../../../.agents/notes/implemented/architecture/2026-09-03-one-shell-tool-per-role.zh.md)——方言配置选择了什么，以及两种 shell 之间真正的差异。
- [tool-terminal](../../terminal/tool-terminal/README.zh.md)——面向交互工作的六个模型侧 terminal 工具。
- [持久 PTY 会话 Agent Note](../../../.agents/notes/implemented/feature/2026-07-16-persistent-pty-sessions.zh.md)——按所有者会话的设计及其理由。
- [生成的工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shell-persistent)——`bash` 与 `pwsh` 参数 schema 的确切内容。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-tool-shell-persistent)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

所挂载方言对应的生成 [`bash` 或 `pwsh` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-shell-persistent)——绝不会同时看到两者，因为一次挂载只注册一个名字——包括配置的 `description`。本插件不贡献独立的系统提示词区段；人设与环境指引由部署方负责。

#### Token 影响

工具可见期间产生固定 schema 开销。

#### KV Cache 影响

只要方言、配置的描述与 schema 不变，前缀就保持稳定。

### 工具结果

#### 模型看到什么

命令共享每个 Agent 一个 shell，因此 cwd、导出的或 `$env:` 变量、已激活的环境、函数与后台任务都会跨调用保留。结果排除私有完成标记，在 pwsh 方言下还排除私有提示词与任何回显的 wrapper 源文本。当命令在没有完成标记的情况下结算——`exec`、中断、bash 后端证明其 stdin 等待的交互式前台子进程之后，或 pwsh 提示词重新出现时——调用返回捕获的部分输出，在 bash 方言下它可能以后端自己的提示词文本结尾。非零的包装命令追加 `[exit code: N]`；在报告该状态前就退出的 shell 改为追加 `[shell exited: code N]`、`[shell killed by signal: SIG]`，或后端两者都未提供时的 `[shell exited]`，然后重置并告诉模型下一次调用从全新状态开始。长输出保留最早的已保留前缀并附裁剪通知。若 PTY 已经丢弃该前缀，结果会明确说明，而不是把尾部当作完整输出呈现。超时返回有界部分输出、关闭不确定的 shell 并报告重置。

#### Token 影响

依数据而定。`maxOutputChars` 限制保留的命令输出；固定的裁剪、丢失前缀、状态、超时与重置诊断可能延长结果。

#### KV Cache 影响

仅追加的工具结果位于可复用请求前缀之后。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明工具何时不合适或需要特别小心。它们是当前包约束，不是任务积压。

- **工具需要拥有者 Agent 与方言匹配的真实 PTY 后端**——无 agent 的调用、方言不匹配的后端，以及无法启动交互 shell 的后端都会失败。
- **pwsh 方言无法抑制输入回显**——PowerShell 的 PSReadLine 会把提交的输入回渲染进终端流，且没有等价的 `stty -echo`。标记锚定提取在完整结果中排除回显，wrapper 源剥除覆盖回退路径，但跨终端宽度换行的 wrapper 可能在部分输出结果中留下残缺回显，受 `maxOutputChars` 设界。
- **pwsh 命令中的原始 ESC 字符不受支持**——PSReadLine 会在执行前消费它们。wrapper 只转义自己需要的控制字节（用 `[char]27` 构造的 OSC 标记、命令体的反引号转义）。
- **模型重定义 pwsh 的 `prompt` 函数会移除就绪标记**——shell 随后按静默层级结算，而不是走标记快路径。
- **Windows 上没有 SIGTSTP/SIGHUP**（后端拒绝）；SIGINT 以控制台级 Ctrl-C 输入写入投递，在提示符处会取消待处理的行，而不是向进程发送信号。
- **交互式前台子进程只在子进程提供方证明其 stdin 等待时才提前返回部分输出**——否则调用一直运行到 `timeoutMs`。
- **显式 `exit` 与超时会丢弃 shell 状态**——取消同样重置并丢弃结果，即使完整状态标记已经可观察；下一次调用启动全新 shell。
- **网络访问与包镜像等环境事实属于配置的 `description`**——而不是本包的默认描述。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
