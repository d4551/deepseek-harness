# Agent Note：带滞后水位线的检查点感知自动压缩

Status: implemented

[English](2026-09-01-checkpoint-aware-auto-compaction.md) | 中文

## 问题

自动压缩锚定头部且只有单一触发：每次压力压缩都遮蔽表层头部——包括上一个检查点——并在压力刚低于阈值时停止。由此产生三项成本。第一，每次压缩都重读并重新合并整个先前检查点，即使只需要浓缩一小段新内容，摘要器输入仍会向上下文窗口增长。第二，刚低于阈值就停止意味着下一步又会越过它：一次压力越界会导致此后几乎每一步都触发一次压缩。第三，未能缩小其范围的摘要会中止整个压力压缩，而下一步会永远重试同一个失败的调用。

## 决策

### 压力压缩朝滞后水位线浓缩

`BasicCompactionConfig` 新增 `targetRatio`（默认 `0.85`）。`resolveCompactSpec` 将其缩放为 `targetTokens = floor(thresholdTokens × targetRatio)`。压力压缩在压力仍不低于水位线时持续浓缩，受 `compactionRetries` 约束，低于水位线即返回；若尝试耗尽时压力仍不低于阈值，则照旧抛出收敛错误。因此一次落地会停在远低于触发点的位置，下一次触发需要新增增长，而不是一步之后。

保留必须低于水位线：不低于 `thresholdRatio × targetRatio` 的比例保留在加载时失败，不低于 `targetTokens` 的绝对 `retainTokens` 在首次使用时失败，与既有的阈值校验对应。

### 范围选择具备检查点感知

`selectCompactableRange` 返回判别式计划：携带策略的 `range`，或给出原因的 `none`（`empty`、`all-retained`、`unbalanced` 或 `checkpoint-only`——即只会遮蔽一个孤立检查点的合并范围）。保留与配对平衡游走之后，策略按表层头部的压缩检查点节点计数解析：

- **零个头部检查点**——照旧从头部合并。
- **一个头部检查点**——当较新范围达到 `MIN_SKIP_SPAN_ROUTE_TOKENS`（512）时跳过它、只遮蔽较新范围；否则合并，因为更小的范围很可能无法通过缩减比较，只会浪费一次模型调用。
- **两个或更多头部检查点**——从头部合并，使表层永远不会累积一串摘要；下一次越界会把它们归并回一个。

同一次压力压缩的后续轮次始终合并，因此一次未充分降压的跳过压缩之后总会跟随一次合并。溢出恢复保持强制一次最大头部合并，不变。

### 缩减失败以合并方式重试

缩减比较抛出类型化的 `SummaryShrinkError`。压力循环将其视为单轮失败，记录日志，并继续下一轮（合并）；当每一轮都无法缩小时，重抛最后一个缩减错误。显式 `compactRegion` 调用方仍将其视为普通失败。一次压缩因此不再可能卡在每一步重复同一个失败调用。

### 事务改用 promise 边界的 result 处理

先记录标记的区域事务保持其事件序列与崩溃契约——一次 `compaction/start`、恰好一次 `compaction/end` 尝试、失败的闭合留下阻塞性未匹配标记——但不再使用 `try/catch`。标记之后的阶段在一个 async runner 内运行，其抛出会沉降为 rejection，调用方以类型化 result 检查读取沉降结果后再进行闭合尝试。`region.ts` 单体拆分为 `selection.ts`（范围选择、定价快照、稳定性检查）、`transaction.ts`（事务）、`lock.ts`（入口状态与锁断言）、`auto.ts`（自动 listener）、`manual.ts`（空闲接纳入口点）、`target.ts`（路由目标解析）与 `schema.ts`（Loader schema），全部低于 400 行上限。

## 备选方案

- **保持单检查点头部锚定**——被否决：每次压缩都要重读整个检查点，且检查点无界增长，而较新内容单独浓缩的成本更低。
- **压缩到固定绝对目标**——被否决：该后端的比例本来就能跨模型缩放；比例水位线复用既有策略机制。
- **摘要未缩小时中止整个压力压缩**——即旧行为；被否决，因为同一个失败调用会在每一步重试。
- **溢出恢复时保护失败请求的驱动 user 消息**——被否决：失败请求由整个表层重建，保护其首条消息会使主体位于其后的失控工具轮次无法恢复；既有的最新配对保留已逐字保留请求的最后单元。

## 后果

- 两次越界之间，自动表层上最多可并存两个检查点；下一次压力越界会合并它们。手动中段压缩仍可能留下更多。
- `compactIfNeeded` 记录每次成功替换及其策略（`skip-checkpoint` 或 `consolidate`），并在压力仍存在但无可用范围时按原因告警。
- `selectCompactableRange` 不再返回 `null`；调用方按 `kind` 分支，并以 `reason` 作诊断。
- `compaction/summary` 与替换事件、持久锁和 `CompactionResult` 不变；只有选择策略、重试循环与模块布局变化。

## 测试

`compaction-selection.spec.ts` 覆盖水位线解析与两种保留校验、跳过／合并／下限选择（含双检查点归并）、越过阈值后向水位线的带内继续、缩减失败后的合并与最终缩减错误重抛，以及携带原因的告警。旧 `compaction-basic.spec.ts` 拆分为 `compaction-config`、`compaction-pressure`、`compaction-region`、`compaction-summarizer`、`compaction-auto-pressure`、`compaction-auto-recovery` 与 `compaction-image` 七个 spec，共享 `tests/harness.ts`，既有期望已更新为水位线下的调用次数。循环、手动与 Loader 套件保持不变且全部通过。
