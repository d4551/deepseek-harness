# Agent Note: 为 swarm 模式、多根会话、工作区来源与路由托管补上用户界面

Status: implemented

[English](2026-09-03-user-facing-surfaces-for-shipped-capabilities.md) | 中文

## Problem

有六项能力已经交付，却没有任何界面让人看见或使用它们。

**Agent Teams 有浏览器 UI，却无处可达。** `packages/client/ui-agent-team` 完整且有测试，而唯一挂载它的 patch——`dsh-agent-team-web-profile`——是一个任何 `dsh --profile` 都无法命名的私有包。内置的 `swarm` 模板叠在 `headless` 之上，而 `headless` 根本不提供浏览器，因此 roster、任务板与 mailbox 渲染给了空气。

**多根会话没有任何客户端界面。** Host 以 `workspace/roots` 事件记录附加根目录，沙箱写入围栏、搜索覆盖、语言服务路由与按根加载的指令都会解析它们，但没有任何客户端源码读写它们。人看不到会话在哪些目录中工作，无法向运行中的会话添加目录，也无法移除；一个 Workspace 就是一个根目录，且只在会话创建时选定。

**网络驱动器工作区与本机磁盘无从区分。** 在 `hosted` profile 中，会话工作区是远程驱动器的物化镜像，而界面对此只字未提。

**LiteRT 路由与云端 API 无从区分。** `dsh-llm-litert` 在部署自有硬件上、或在部署指定的服务器上提供模型；模型选择器只显示一个 provider 名称。

还有两处界面没有说出读者需要的事实。**浏览器渲染的抓取读起来与普通抓取一样**：内置默认 `fetchProvider: playwright` 会执行页面的 JavaScript，而抓取卡片只携带 `url`、`statusCode` 与 `truncated`。**shell 卡片没有说明方言**：`tool-bash` 与 `tool-pwsh` 已合并为按方言参数化的 `dsh-tool-shell`，方言在启动时按宿主平台选定，因此阅读记录的人无法判断命令是用哪种语言写的。

## Decision

### `swarm-web` 成为内置 profile 模板

`PROFILE_TEMPLATES` 新增 `swarm-web`：`dsh-base`、`dsh-web-app`、`dsh-swarm-profile`、`dsh-agent-team-web-profile`，采用实时 patch 重载。`swarm` 模板叠在 `headless` 之上的同一层 Host swarm 层，改叠在 `web-app` 之上，浏览器层再补上渲染 Team 的那一行。

`dsh-agent-team-web-profile` 不再是私有包：内置模板的 bundle 必须能从打包安装的 `@deepseek-ai/dsh` 中解析，因此该包改为发布，CLI 在 `dependencies` 中声明它。它的兄弟包 `agent-team-profile` 保持私有——那一层只在 `dsh-base` 之上叠加 Agent Teams，没有任何内置 profile 会叠它。

不涉及 Team-aware Agent preset。Team 工具注册在每个 Agent 自身的 scope 中，而工具注册表让较近的 scope 胜过较远的，因此对每个 Team 成员来说，Team scope 的 `list_agents`、`send_message` 与 `interrupt_agent` 会遮蔽 preset scope 中的同名 continuable child 控制项。每个根 Agent 都隐式是 Team Lead，因此每个 `swarm-web` 会话打开时面板就已有内容。

### 工作目录 seam 补齐缺失的两个角色

读取侧是 **projection**：`workspaceRoots` 折叠会话的 `workspace/roots` 事件，并与会话头的 `cwd` 配对，由 Session Controller 在 `modelSelection` 旁注册。客户端通过标准套件的 `useProjection` 读取，因此渲染出的集合就是折叠后的日志，实时且断线重连后依旧正确，无需客户端折叠，也无需轮询。

写入侧是 **Remote 命令**：`session.setWorkspaceRoots` 在解析 Session 之前先校验每条路径为绝对路径——与 `session.create` 相同的顺序，使执行层无法匹配的根目录永远不会进入持久记录——随后调用 `setAdditionalWorkspaceRoots`，其单个 `workspace/roots` 事件就是这次变更。

Consumer 是新包 `packages/client/ui-workspace-roots`：一个会话标题栏操作项，其面板列出带文件系统来源标签的主目录、每个附加根目录，以及增删控件。变更从不乐观更新；行的变化发生在结果事件经 projection 折叠回来之时。

### 文件系统来源是 seam 上的能力事实

`FileSystem` 在 `sandboxMode` 旁新增 `origin` getter——后者正是「界面读取的能力事实」的既有先例。基类与每个宿主磁盘后端报告 `local`；`NetworkDriveFileSystem` 覆写为 `network-drive`。`FsOriginKindMap` 可合并扩展，因此后来的后端可声明自己的成员，消费者的 switch 走一条有文档的默认分支。

`session.workspaceOrigin` 是其 wire 面，通过 `ctx.get('fs')` 读取，因为该 seam 对这个包是可选的：未组合文件系统 provider 的部署得到 `null`，即什么都不声称，而不是谎称本机磁盘。来源按部署而非按根目录——harness 只运行一个文件系统 provider——因此面板给主目录打标签，而这个标签描述该会话触达的每一条路径。

### 路由托管是 LLM seam 上的能力事实

`LlmProviderInfo` 新增 `hosting?: 'local' | 'self-hosted'`，读法与 `LlmConfigurableProvider.declared` 相同：缺省表示适配器不作此区分，而这对硬件情况 harness 一无所知的云端 API 正是唯一诚实的答案。`LitertAdapter` 继承 `PiAiAdapter`，附上其配置解析本就选定的姿态。注册表把它带进 `listProviders()`，`buildModelCatalog` 带进分组，模型选择器把它渲染为分组标题的一部分，因而并入分组的可访问名称。

不存在「已加载 / 导入中」状态可展示。`dsh-llm-litert` 会先导入模型并等待服务器健康，然后才注册适配器，因此仍在导入的路由根本不在目录中。

### 网页抓取说明获取方式

`WebFetchResult` 新增 `retrieval?: 'http' | 'rendered'`。HTTP provider 声明 `http`；Playwright provider 声明 `rendered`。它在 seam 上是可选的，因为只有 provider 能回答，而本仓库之外的后端可能不回答。

`presentationMeta` 只能读到已声明的输出值，因此该事实经工具输出 schema 的一个可选字段进入持久化的结果 meta，而卡片正是从中派生的。`fetchMetaFromResult` 会丢弃闭合取值对之外的值：在关乎信任的卡片上写出无法识别的词，比什么都不声称更糟。卡片显示「浏览器渲染」或「直接抓取」，并以更完整的句子作为 title。

### shell 卡片说明方言

`dsh-tool-shell` 以其方言名注册，因此一次调用的工具名就是它的方言。`terminalCardModel` 把 `bash` 或 `pwsh` 带到卡片上，`TerminalBlock` 在状态旁渲染为徽标。`terminal_send` 调用不声明方言：该会话的 shell 从来不是 harness 选的。

## Alternatives considered

**让 `swarm` 自己提供浏览器。** 否决：`swarm` 是由一支队伍完成的一个 headless 任务，其 `startup` patch 重载生命周期的存在，正是因为在一次性应用运行中替换其依赖会破坏该生命周期。单独的模板让两种姿态并存。

**把 `ui-agent-team` 行放进 `dsh-swarm-profile` 自己的 patch。** 否决：那样 `swarm` 模板会往没有浏览器的树中插入一行浏览器条目，而每个 headless 安装都会带上一个它从不提供服务的客户端依赖。

**为 `swarm-web` 写一个 Team-aware Agent preset。** 在确认 scope 遮蔽后否决为不必要：Team scope 的工具对 Team 成员本就胜过 preset scope 的同名工具，因此 fork 一个 preset 只会复制标准 preset 而不改变任何可观察行为。

**用 Remote 调用而非 projection 读取根目录集合。** 否决：调用是需要失效策略的点读，而浏览器本就在接收 projection 帧。折叠是纯函数，整值事件规则让每个 `workspace/roots` 事件自描述，因此 projection 既更省，也对断线重连安全。

**让面板乐观地持有根目录列表。** 否决：会话的根目录由 Host 决定，而被拒绝的变更所遗留的乐观行会与沙箱围栏相互矛盾。面板渲染 projection，并以可重试的方式呈现失败。

**在根目录面板中内建目录树。** 暂时否决：`ctx.uiWorkspace` 已经拥有宿主选择器，而输入绝对路径在每种部署下都有效，包括其组合选择器只提供 browse 能力的部署。面板的 `Known Limitations` 记录了这个缺口。

**把工作区来源放进 `workspaceRoots` projection。** 否决：projection 折叠的是会话日志，而组合出的文件系统后端不是会话日志中的事实。它是部署级探测，与 `canOpenWorkspacePath` 同类。

**从 Session Controller 的浏览器词汇中再导出 `FsOrigin`。** 否决：那会为了一个字符串，把 `dsh-fs` 及其 cordis Context 合并塞进客户端程序的类型图。该 Remote 声明自己的 `SessionWorkspaceOrigin`，其 `kind` 以普通字符串跨越 wire——可合并扩展的词汇在 wire 上本就该是这个样子。

**在模型选择器中按 provider id 特判 LiteRT。** 否决：那样选择器就会知道某一个适配器的名字，而第二个本机适配器又需要再来一次特判。由适配器声明其模型运行在何处，选择器渲染任何适配器声明的内容。

**在渲染时依据当前组合的 provider 推断抓取方式。** 否决：卡片重放的是已经发生的调用，而组合的 provider 可能在调用与重放之间发生变化。由 provider 按每次结果记录它。

**不让抓取方式进入模型视野。** 做不到：`output.presentationMeta` 只接收已声明的输出值，而卡片必须从持久化的结果 metadata 派生。让它对模型可见本身也站得住脚——页面脚本是否运行过，会改变返回文本中理应包含什么。

## Consequences

`dsh --profile swarm-web` 渲染 Team roster、任务板与 mailbox；启动该 profile 并从服务端返回的浏览器名册中获取 `/plugins/??@deepseek-ai/dsh-client-ui-agent-team/client.js`（HTTP 200，208 kB）予以验证。

人可以从对话标题栏读取并修改运行中会话的目录集合，且该变更是持久的：添加目录会向会话日志追加 `workspace/roots`，而这正是每个根目录消费者所折叠的内容。`session.workspaceOrigin` 在宿主磁盘部署上返回 `{"kind":"local"}`，在 `hosted` 下返回 `network-drive`。

现在每张抓取卡片都会说明是否有浏览器引擎运行过该页面，每张 shell 卡片都会说明其命令是用哪种语言写的。两项事实都按调用记录，因此重放的记录说明的是实际发生了什么，而不是当前组合会怎么做。

三个 seam 各增加了一个可选成员（`FileSystem.origin`、`LlmProviderInfo.hosting`、`WebFetchResult.retrieval`）。每一个都遵循「缺省即未声明」，因此本仓库之外的 provider 继续可用，其界面保持沉默而非猜测。

`dsh-agent-team-web-profile` 现在是发布产物的一员。它发布依赖的 `dsh-client-ui-agent-team` 本就是公开包。

## Testing

`packages/client/ui-workspace-roots/tests` 覆盖四种状态、两种变更、包括卸载竞态在内的每条失败路径，以及触发器、面板、警示与加载占位的 axe 底线。`packages/api/session-controller/tests/session-workspace-roots.host.spec.ts` 覆盖 projection 折叠、替换命令，以及经生成的 Remote 面进行的来源探测。provider 级别的事实在其产生处断言：HTTP 与 Playwright provider 各自钉住自己的 `retrieval`，LiteRT 插件 spec 钉住两种姿态的 `hosting`。

## Deferred

根目录面板没有内建目录浏览器，因此其组合选择器只提供 browse 能力（而非原生选择器）的部署会在「浏览…」上收到拒绝，只能依赖输入字段。

Team 面板读取 Lead 的 Team；teammate 会话显示的是同一个 Team，因为那正是该 teammate 所属的 Team。

## Related

[Swarm 可达性与子会话根目录](../architecture/2026-09-03-swarm-reachability-and-child-roots.zh.md)负责 headless 的 `swarm` 模板、`dsh-swarm-profile` 的发布，以及附加根目录跨委派边界的继承。`swarm-web` 把同一层 Host 层改叠在 `web-app` 之上，而本记录新增的面板正是让继承来的根目录集合可见的界面。
