# Agent Note：指令发现的读取边界与根目录稳定性

Status: implemented

[English](2026-09-01-instruction-discovery-bounds-and-root-stability.md) | 中文

## Problem

`packages/context/agent-instructions` 中的三个标记，分别指出发现流程可能读错对象、或读得过多的三条路径。

`TODO(root-marker-unavailable)` 位于 `existsAsMarker`。提供方的 `resolve`/`stat` 抛错，以及宿主 `stat` 因任何原因失败，都会返回 `false`——这与标记确实不存在时的答案完全相同。`findProjectRoot` 把 `false` 当作“继续向上走”，于是无法探测的目录被径直越过。当某个祖先目录带有根标记时，发现流程就会采纳该祖先项目的根，而每一个相对 scope 键都会据此计算。

`TODO(frozen-project-root)` 位于对账流程。项目根在每一轮都从会话 cwd 重新计算。scope 键是相对该根存储的，因此会话中途新增或删除根标记会重新解释已经记录的每一个键，`workspaceBaselineIdentity` 也随之改变，从而替换掉基线。

`TODO(total-instruction-read-bound)` 位于 `readBounded`。`maxSourceBytes` 只约束单个文件。没有任何东西约束一个批次，因此由大量各自很小的指令文件构成的目录树会被无界地读入内存；`maxBytes` 只在渲染时裁剪，而那已经是在每个被接受的文件都读完之后。

## Decision

**探测失败不等于不存在。** `existsAsMarker` 返回 `'present' | 'absent' | 'unavailable'`。提供方分支在 `resolve` 或 `stat` 抛错时报告 `'unavailable'`，宿主分支则把 `ENOENT` 与其他所有 errno 区分开。`findProjectRoot` 在 `'unavailable'` 时返回会话目录：状态未知的目录绝不被越过，因此发现流程不会仅凭一次失败的探测就跨入祖先项目。这个安全答案与无标记目录树本就会产生的答案一致。

**一个会话只保留一个根。** 循环持有一个 `WeakMap<Session, string>`，每个会话只解析一次项目根，并通过本就存在的 `projectRoot` 选项传给对账流程。在该根之下记录的 scope 键在会话生命周期内保持可比，基线身份也不再因标记的出现或消失而变动。`reconcileInstructionContext` 内部的发现逻辑保留为兜底，服务于不持有既定根的调用方。

**批次拥有总量预算。** `SourceBudget` 承载一个批次还可读取的字节数。`readBounded` 将每个文件的上限取为 `Math.min(maxSourceBytes, budget.remaining)` 并扣减被接受的字节，因此即便每个文件都符合各自的上限，批次总量仍然有界。一次基线加载开启一个预算；一次对账批次开启一个。该边界由 `maxTotalSourceBytes` 配置字段给出，默认为单文件上限的八倍——远高于以千字节计的真实指令集，同时仍能约束病态目录树。它与 `maxBytes`、`maxSourceBytes` 一并进入 `workspaceBaselineIdentity`，因为它决定了一条基线包含哪些文件。

## Alternatives considered

**在无法探测的目录上抛错。** 足够响亮，但对这个调用并不合适：标记探测会向上穿过会话本无所有权的目录，因此工作区之上的权限错误属于预期而非异常。停止上行即可回答它，无需让该轮失败。

**重新计算根，但迁移 scope 键。** 需要在新根之下重写已记录的键，并调和会话日志中既有条目的两套命名。保留根完全避免了这次迁移；确实需要新根的会话本就是一个新会话。

**由 `maxBytes` 推导总量边界。** 渲染预算约束的是抵达模型的内容，而非发现流程读取的内容，且两者之间还隔着去重，因此二者并不成比例。独立字段直接陈述读取边界，并保持可从 `cordis.yml` 修改。

## Consequences

- 会话目录及其以下发生的探测失败，会产出会话目录本身作为项目根，而不是某个祖先的根。
- 会话中途创建或删除根标记，不再移动根、scope 键或基线身份。
- 批次在其总量预算耗尽后停止接受文件；文件按发现顺序扣减，因此靠近根的文件先被读取。
- `maxTotalSourceBytes` 出现在 `Config`、生成的配置目录以及 `workspaceBaselineIdentity` 中。两份钉住该身份的会话 fixture 已以无密钥方式刷新。
- 非正或非有限的 `maxTotalSourceBytes` 会禁用加载，与 `maxBytes` 和 `maxSourceBytes` 的既有行为一致。

## Testing

`packages/context/agent-instructions/tests/agent-instructions.spec.ts` 新增三组用例。探测结果：仅仅不存在的标记仍会向上走到祖先根；提供方 `stat` 失败会停在会话目录；宿主在不可搜索目录中的探测（`EACCES` 而非 `ENOENT`）同样如此。根保留：首轮之后出现的更近根标记不会替换基线，外层 scope 仍在。总量预算：预算覆盖两个文件时两个都读取，仅覆盖一个时只读第一个，非正预算则什么都不加载。探测与保留两处修复均在原位被逐一回退并观察到对应用例失败后才恢复；其中保留用例在最初版本对未修复代码同样通过之后被收紧。
