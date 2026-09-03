---
description: "Web 工作目录界面：会话标题栏面板，列出会话工作的所有目录、其文件系统来源以及增删控件；面向多根会话的使用者与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-workspace-roots

[English](README.md) | 中文

## 概述

本包渲染 Web GUI 的工作目录界面：会话标题栏中的一个操作项，展开后列出该会话工作的每一个目录。在它出现之前，会话的附加根目录只是一项模型能用、而人既看不见也改不了的持久事实：Host 记录它们，搜索、语言服务、按根加载的指令与沙箱写入围栏都会解析它们，而浏览器什么都不显示。这个面板补上了缺失的另一半——当前根目录集合、主目录背后的文件系统来源，以及在运行中的会话上所需的两种变更。

读取走 Host 计算的 `workspaceRoots` projection，因此渲染出的集合始终是折叠后的会话日志，而不是客户端状态。写入走 `session.setWorkspaceRoots`，改变列表的是它产生的 `workspace/roots` 事件。

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

把本插件与运行时一同挂载，「工作目录」操作项便会出现在每个会话标题栏中，其计数包含主目录与每个附加目录。点击即可展开面板。

### 读取根目录集合

第一行是会话的主目录——会话创建时所针对的目录，任何变更都无法改动它——标记为主目录，并带上本部署所组合的文件系统来源标签：本机磁盘，或由 harness 镜像到本地工作目录的网络驱动器。其后每一行都是会话记录的附加根目录。只在主目录中工作的会话会显示空状态，而不是一行列表。

### 增加与移除目录

输入绝对路径，或点击「浏览…」打开宿主的目录选择器并回填该字段。添加会发送完整的替换集合；移除某一行会发送剩余集合。相对路径以及会话已在其中工作的目录会在字段内被拒绝，不发出任何请求。被拒绝或失败的替换不会改动已渲染的行，并提供「重试」——决定会话根目录的是 Host，而不是这个面板。

变更在会话的下一次能力调用解析时生效：下一次搜索会覆盖新目录，语言服务会路由进去，其按根加载的指令会加载，写入围栏也会放行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本包向 `conversation.session.header.actions` 贡献一个条目（`WorkspaceRootsAction`），自身不持有任何根目录状态。行集合来自 `useProjection('workspaceRoots')`，即对 Session Controller 注册的那个 projection 的标准套件读取；主目录是该 projection 的 `primary`（会话头的 `cwd`，无 cwd 的会话为 null），其下各行是它的 `additional`，即会话 `workspace/roots` 事件的折叠结果。

有三个注入动作跨越包边界：`setRoots` 调用 `session.setWorkspaceRoots`；`pickDirectory` 委托给 `ctx.uiWorkspace`，而不是直接触达选择器 Remote；`loadOrigin` 在首次展开面板时按挂载调用一次 `session.workspaceOrigin`，因为来源是部署级常量而非会话事实。

面板渲染四种状态：projection 尚未到达时与触发器同尺寸的忙碌占位、没有附加根目录时的空状态、变更被拒绝时带「重试」的警示，以及行列表。变更从不乐观更新——先发出请求，等结果事件经 projection 折叠回来，行才移动。

| 文件 | 职责 |
|---|---|
| [`src/client/WorkspaceRootsAction.tsx`](src/client/WorkspaceRootsAction.tsx) | 标题栏操作项、面板与四种状态 |
| [`src/client/index.ts`](src/client/index.ts) | 字典与 slot 注册，以及注入动作 |
| [`src/client/locales.ts`](src/client/locales.ts) | `workspace-roots` namespace 的字典 |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当面板不够用时可读这些页面。它们从浏览器界面走向持久记录以及解析它的各层。

- [Session Controller](../../api/session-controller/README.zh.md)——注册 `workspaceRoots` projection，并拥有 `session.setWorkspaceRoots` 与 `session.workspaceOrigin`。
- [dsh-session](../../core/session/README.zh.md)——`workspace-roots.ts` 是写入路径，也是每个消费者读取的折叠。
- [dsh-sandbox-policy](../../sandbox/sandbox-policy/README.zh.md)——把记录的根目录转成写入围栏。
- [ui-workspace](../ui-workspace/README.zh.md)——Workspace 选择器，以及本包借用其目录选择器的 `ctx.uiWorkspace` 能力。

-----

<a id="model-experience"></a>
## 模型体验

通过 `session.setWorkspaceRoots` 追加的 `workspace/roots` 事件间接产生影响：折叠该事件的搜索、语言服务、按根指令与沙箱消费者负责全部模型可见效果，本包自身不注册任何提示词区块、工具或 schema。

#### KV Cache 影响

本包自身的渲染没有影响。增删根目录会改变后续请求组装的按根指令文本，而该组装自身的前缀稳定性由 `dsh-agent-instructions` 负责，不由本包负责。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

以下限制界定了当前面板。它们是本包当前的约束，不是通用的多根方案对比，也不是任务积压清单。

- **主目录固定不变**——按会话契约，会话的 `cwd` 不可变，因此面板可以增删附加根目录，却永远无法重新指定主目录。要在不同的主目录中工作，需要新建会话。
- **路径靠输入或选择，不在原地浏览**——面板没有内嵌目录树。若某部署组合的选择器提供的是 browse 能力而非原生选择器，「浏览…」会被拒绝，在那里仍以输入字段作为添加目录的方式。
- **根目录按提供的写法记录**——Host 按字面写法去重并剔除主目录的写法，且不做任何文件系统访问。因此同一目录的两种写法都会出现在列表中；规范化属于解析它们的执行层。
- **来源按部署而非按根目录**——harness 只组合一个文件系统 provider，因此来源标签位于主目录上，并描述该会话触达的每一条路径。未组合文件系统 provider 的组合不显示标签，而不是宣称本机磁盘。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
