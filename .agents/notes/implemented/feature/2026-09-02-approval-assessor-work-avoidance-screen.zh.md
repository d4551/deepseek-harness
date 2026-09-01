# Agent Note: Work-avoidance screening at the approval gate

Status: implemented

[English](2026-09-02-approval-assessor-work-avoidance-screen.md) | 中文

## 问题

自主会话可以在审批关口放弃被指派的工作，而没有任何工具拒绝它：模型请求权限时把放弃写进理由——"既然是既有的，我可以跳过吗？"、"这是已知限制，就这样吧"——而只看工具名的操作者看到的是普通的审批问题。审批瀑布中没有任何环节检查理由文本，于是把用户指令说没的理由与诚实的理由走的是同一条通道。

## 决策

`packages/guard/approval-assessor`（`@deepseek-ai/dsh-approval-assessor`）在面向用户的应答者之前监听 `approval/request` 瀑布，将每个请求的理由与规避工作的模式比对——即否认所有权、时间推诿、范围推脱、嫌麻烦退缩的词汇。命中时直接判定 `rejected` 而不调用 `next()`，插件追加一条 `user/message`（来源 `plugin: approval-assessor`），引用会话中最近的用户指令，使模型在拒绝旁边读到原始任务并回到它。工具为 `bash`、`write` 或 `edit` 的请求无条件放行：这些工具的审批由各自的安全策略管辖，理由文本筛查不得变成它们面前的第二道闸门。不匹配的理由原样委托。`enabled: false` 委托一切；`extraPatterns` 在加载时编译会话专属的正则源，非法模式会在加载时大声失败。

`./invariant` 伴生件持有一条运行时关系：本插件注入的每条 `user/message` 必须在会话中存在未决的审批问题时追加（位于其 `approval/asked` 与 `approval/decided` 之间），因为该注入只作为该问题的拒绝上下文而存在。

规范的 README 限制章节标题（`## Known Limitations and Deferred Work`）被宿主 MAS no-weasel-words 写入门禁逐字拒绝，该门禁把 "known limitation" 短语读作接受性措辞。因此该包在 `scripts/verify-package-readme-limitations.ts` 中被列入白名单，冲突原因记录在条目中，其 README 以 `## Behavior Boundaries` 章节记录边界。

## 考虑过的替代方案

**通过交互权限层而非瀑布监听器拦截。** 否决：权限回答的是谁可以运行工具，而不是为何请求；失败模式存在于理由文本中，筛查应位于理由所附着的审批请求上。

**无视安全类别拦截所有工具。** 否决：`bash`、`write`、`edit` 携带各自的审批策略，理由文本在那里不是决定输入；在它们面前的模式匹配可能拒绝其策略本会允许的请求，使策略面翻倍。

**以系统提示增补而非会话事件注入重定向。** 否决：模型可见输入必须可从会话日志重建，一次性的拒绝上下文作为持久的提示事实是错误的。

## 后果

模型再也无法通过措辞引导审批通道放弃用户指令：理由本身就是触发器，拒绝携带指令回到模型。代价是基于理由文本匹配而非意图分析——不命中任何模式的转述会被委托，需要更广词汇的会话必须配置 `extraPatterns`。重定向在每次拒绝后追加一条短消息，先前的会话缓存不受影响。MAS 标题冲突使该包失去规范的限制章节标题：白名单条目与 `## Behavior Boundaries` 承载该事实，偏差在验证器的允许列表中可审计而非隐藏。十六个行为测试固定了放行、拒绝、注入形态、配置校验与禁用路径。
