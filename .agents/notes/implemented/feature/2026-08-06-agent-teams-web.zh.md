# Agent Note: Agent Teams Web 控件

Status: implemented

[English](2026-08-06-agent-teams-web.md) | 中文

## 问题

持久 Agent Teams runtime 负责 roster、mailbox 与 task 状态。Web 用户需要查看 teammate 活动、按同样的 compare-and-set 规则管理共享任务，并打开 teammate 会话。这些操作必须由 Team service 负责，不能在 API Proxy 或 Session Controller 中重复定义其约定。

## 决策

私有 `ctx.agentTeams` service 除 domain operation 外，还直接负责生成式 `agentTeams/view`、`agentTeams/createTask` 与 `agentTeams/updateTask` Remote method。Team package 负责浏览器安全的 view 与 mutation-result type。View 包含 roster 与当前 task 状态，但不包含 pending mailbox 内容或已删除 task tombstone。Create 与 update rejection 通过封闭 business result 跨越 Remote；过期的 update revision 保留为 `team-task-conflict`，其他 Team rejection 保留为 `team-rejected`。意外 failure 仍是普通 `RemoteResult` failure。

`@deepseek-ai/dsh-client-ui-agent-team` 通过 `ctx.remote` 挂载 `@deepseek-ai/dsh-agent-team/remote` contribution，随后直接消费生成式 `ctx.remote.agentTeams` method。它展示 roster status、model 与 diagnostics，并支持 task create、edit、dependency update、assignment、completion、reopen 与 deletion。每次 update 都发送当前显示的 revision。每个 create 或 update 都独立持有 pending token，在开始前使更早的 refresh 失效，并在成功后重新读取完整 Team view。Conflict 仅在其 reload 成功后要求用户检查；如果重新读取失败，则保留该错误。重叠 refresh 只发布所选 Session 的最新请求。

面板打开时订阅 `agentTeams/changes`，并在读取 view 期间合并活动通知。关闭面板、切换会话或卸载会取消订阅，并使未完成的读取失效。任务表单使用共享输入与按钮组件，提供持久标签、原生 Enter 提交，并在保存期间禁用字段。Escape 与关闭按钮恢复触发按钮焦点；外部指针关闭保留被点击目标的焦点。

Teammate navigation 使用既有 `{ parentSessionId, childSessionId, mode: 'continuable' }` Subagent address，不带 Team tag。UI 刷新直接 child catalog、再次检查所选 Session，然后打开 addressed conversation。History 与后续人类 prompt 使用稳定 Subagent 路径；Team mailbox 只用于 Team 工具发起的 Team peer delivery。

`dsh-web-app` 在 `ui-subagent` 之后以 `ui-agent-team` 行挂载该 UI，位于 `dsh-base` 挂载的 `ctx.agentTeams` 服务与模型工具之上（[Agent Teams 随每个 profile 交付](../architecture/2026-09-07-agent-teams-in-every-profile.zh.md)）。

Web preset 还会在自身 preset scope 内注册 continuable Subagent control。注册在每个 Agent 自身 scope 中的 Team 工具会遮蔽这些 control，因此模型看到的 roster 是 Team 的。重复注册仍是组合配置缺陷。

## 边界

Web UI 不提供 mailbox timeline、worktree 或 Git control、teammate creation、rename、deletion、interrupt 或自动 merge。它不会从 task ownership 或 write scope 推断文件系统权限。导航到 teammate 后的人类 continuation 是普通 addressed-child prompt，不是 Team mailbox message。

## 考虑过的替代方案

**扩展 API Proxy Team RPC map。** 拒绝，因为这会在第二个 wire package 中重复生成式 Remote vocabulary 与 validation。

**引入独立的浏览器 Remote service。** 拒绝，因为这些 method 没有区别于 `ctx.agentTeams` 的状态、lifecycle 或 policy owner；第二个 Cordis service 会重复 Team injection，并要求另一个 package 提供同一个 Typert namespace。

**向 Subagent address 与 prompt routing 添加 Team metadata。** 拒绝，因为普通 child navigation 已经标识会话；Team tag 会让 Client 与 Subagent contract 耦合 mailbox policy。

**在 Web bundle 中加入禁用 Team row。** 禁用 row 会在包含依赖的同时让用户无法使用控件。[Profile 组合决策](../architecture/2026-09-07-agent-teams-in-every-profile.zh.md)同时挂载启用的 Team 控件及其 service。

## 测试

Team service 测试与构建产物检查验证 Remote method、error mapping 与导出 descriptor。Client 测试覆盖 namespace 挂载、Lead routing、任务操作、pending operation、conflict reload、陈旧回复、navigation、dispose、状态呈现、持久标签和键盘提交。组装式浏览器测试运行真实 Host Remote flow、实时更新和子会话，并在明暗主题下执行整页 axe 检查。这些无密钥测试不证明真实模型行为。

## 后果

Team service 负责 domain state 与公开选定 Team value 的 Remote operation。API Proxy 和 Session Controller 保持普通会话约定。每个 Web profile 都通过 Web bundle 挂载 Team 控件；用户不需要添加额外 profile 层。
