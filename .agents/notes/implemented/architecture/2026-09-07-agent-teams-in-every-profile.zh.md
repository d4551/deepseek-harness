# Agent Note: Agent Teams 随每个 profile 交付

Status: implemented

[English](2026-09-07-agent-teams-in-every-profile.md) | 中文

## Problem

Team 服务、其作用域内的工具、Agent Teams 面板和 Agent team 设置卡片只能通过 `swarm` 与 `swarm-web` 两个 profile 到达用户，因为 [swarm 可达性 note](2026-09-03-swarm-reachability-and-child-roots.zh.md) 把按需选用的东西排除在交付默认值之外。其他每一种执行类型——`web`、`headless`、`hosted`、`sdk` 与 `acp`——启动时都没有它们。由 `dsh-base` 与 `dsh-web-app` 组合而成的部署（也就是所有者的 DeepMeow 安装所运行的部署）既不显示 team 卡片，也不显示 team 面板，其模型更完全无法创建 teammate。所有者裁定这项能力属于每一种执行类型，部署不应该必须知道某个 profile 名称才能看到仓库交付的插件。

按需选用层还带来了两个包，其全部内容只是行的副本：`agent-team-profile` 在 `dsh-base` 之上插入 Team 行并禁用与 Team 工具同名的全局可续子 Agent 控制，`agent-team-web-profile` 插入一行浏览器条目。[漂移 note](../process/2026-09-03-swarm-layer-drift-and-atomicity-scope.zh.md) 不得不添加测试，才能让 `swarm-profile` 与 `agent-team-profile` 不彼此分叉。

## Decision

`dsh-base` 为每个 profile 挂载 `agent-team` 与 `tool-agent-team`，采用委派策略、八人名册以及 swarm 层曾重述的同一组 mailbox 与 disposal 限额。该策略告诉模型只在用户要求时才创建 teammate，因此普通会话读到 Team 工具，却不会被引向 swarm。`dsh-web-app` 在 `ui-subagent` 之后挂载 `ui-agent-team`，于是每个 Web profile 都渲染 roster、任务板与 teammate 导航；插件设置页上的 Agent team 卡片在 `agent-team` 命名空间被服务的任何地方渲染，而现在它无处不在。有一个 agent preset 留在外面：`minimal` 承诺恰好只有持久 bash 与字符串编辑器，因此 `tool-agent-team` 新增 `excludePresets`，base 把它设为 `minimal`，会话 header 指明该 preset 的 Agent 既不接收 Team 工具也不接收策略段落。Web bundle 的其他 preset 自行选择委派工具并保留 Team。

`dsh-base` 不再挂载 `tool-subagent-control` 与 `tool-subagent-list-agents`：Team 工具在每个 Agent 自身的 scope 中注册 `send_message`、`list_agents` 与 `interrupt_agent`，遮蔽同名的全局控制，因此那些行已没有任何可达的工具。可续的 `subagent` 行与 `tool-subagent-report` 保留，因为可续 child 仍通过 `report` 回答其父级，Web 或 SDK 客户端仍通过宿主自己的后续操作界面继续它；该工具的可续模式描述不再承诺 `send_message` 能到达这样的 child。Web bundle 自己的 agent preset 保留它那份控制副本，Team 工具对它们的遮蔽与 `swarm-web` 下完全一样。

`swarm-profile` 现在只是对 base 行的重新调校，不插入任何东西：它为 `subagent` 行设界，把 `subagent` 设为一次性，以十六人名册重述 `agent-team`，并以 `coordination: swarm` 重述 `tool-agent-team`。其套件断言每一行都针对一个 base id，每一行只改变其记录在案的值并重述其他所有键，且重新调校后的行能启动成 swarm。`agent-team-profile` 与 `agent-team-web-profile` 已删除；`swarm-web` 模板为 `dsh-base`、`dsh-web-app`、`dsh-swarm-profile`；面板与插件配置的浏览器场景不带任何 overlay 地启动随发布的 bundle。

每个录制会话现在都携带 Team 策略段落与十一个 Team 工具 schema，因此无密钥 golden 已全部刷新。两个 sdk 场景被退役而非刷新：`subagent-continuable` 让模型带着 subagent id 调用全局 `send_message`，`subagent-list-agents` 让模型调用全局 `list_agents`；这两个工具在每个随发布 profile 中现在都是 Team 的，`packages/subagent/subagent/tests/` 与 `packages/subagent/tool-subagent-control/tests/` 下的包套件继续承担那些 transcript 曾展示的行为。引用这两个场景的三份 note 都已如实说明。两个精选组合有意把 Team 排除在外，正如它们排除大多数 base 工具那样：`persistent-tools` sdk 场景在其 patch 中禁用这两行，Python 运行时 smoke 的自定义 profile 把它们列入禁用行，因此其已提交的预期输出仍描述录制时的那组工具。

## Alternatives considered

**保留 Team 作为按需选用层，并把它组合进所有者的部署 profile。** 被所有者否决：插件应该不分执行类型地浮现，profile 名称不应成为随发布能力的门槛。

**在 `dsh-base` 中把 `tool-subagent-control` 与 `tool-subagent-list-agents` 保留在 Team 工具旁边。** 否决：Team 工具在每个 root scope 中都遮蔽它们，它们会处于挂载却不可达的状态，而那两个退役场景照样会坏掉。

**像 swarm 层那样在 `dsh-base` 中把 `subagent` 设为一次性。** 暂不采纳：可续 child 仍是 SDK 与 Web 客户端的持久控制路径，切换随发布的模式会让每个启动后台 child 的录制场景作废。swarm 层保留其一次性覆盖，因为它的运行上限约束的是前台委派。

**把 `coordination` 做成 Agent team 卡片上的用户设置。** 推迟：策略文本今天是组合决策，一个在会话中途改写系统提示词的设置需要自己的日志事件。两种随发布的协作模式仍是 profile 层。

## Consequences

除 `sdk-minimal` 外的每个 profile 在应答时都可用 Team 工具，Web 应用在每个 profile 中都显示面板与卡片，包括仅由 `dsh-base` 与 `dsh-web-app` 构建的部署。这些 profile 中的每个请求都携带委派策略段落与多出的十一个工具 schema，这是按需选用设计曾避免的一项固定、前缀稳定的开销。每个无密钥录制会话的系统提示词与工具列表都发生了变化并已刷新；swarm profile 仍没有录制会话，因为录制需要模型密钥。由旧 `swarm-web` 模板初始化的 profile 目录，其 `package.json` 中仍列有 `@deepseek-ai/dsh-agent-team-web-profile`，必须重新初始化。`scripts/check-workspace-constraints.ts` 中的发布排除 allowlist 为空，因为没有任何 preset 层再保持私有。Web golden 是在排除 `hmr-live.e2e.ts` 的情况下对着生产版客户端构建刷新的：该场景会启动 dev-web watcher，其开发模式构建会就地改写 `apps/web/dist`，并让之后每个场景的客户端因 Cordis inject 错误而崩溃，因此本地刷新须单独运行它。在此变更之前就已在本 fork 上失败的场景保留其已提交的 fixture。
