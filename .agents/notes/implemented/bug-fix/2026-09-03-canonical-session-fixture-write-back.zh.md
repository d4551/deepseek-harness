# Agent Note: 快照写回直接写出规范 fixture 布局

Status: implemented

[English](2026-09-03-canonical-session-fixture-write-back.md) | 中文

## 问题

已提交的会话 fixture（测试前置数据）是持久化 JSONL 日志的投影：它去掉存储层自有的编码，保留 header 与事件 payload。但仍有两种存储编码进入了 fixture 写入器。

`scrubSessionSnapshot` 删除了 `seq`/`time` 与 `seq0`/`time0` envelope，却原样复制了 `sourceEventSeqs` 在 JSONL 存储边界由 `encodeSeqRanges` 生成的区间形式，于是刷新后的 `assistant/message` 记为 `[[12,77]]`，而语料记的是 `[12…77]`。它同样原样复制了持久化 flush 边界产出的打包 chunk 行，于是被切分到两个 `eventLines` 批次的一段 run 保持为两行，而语料记的是一行。

比较路径掩盖了这两点。`normalizeSessionLog` 会解码区间形式的 provenance，另一个重打包步骤会在比较前合并被 flush 切开的行，因此两种布局的 fixture 比较结果相等，`bun run test:snapshot` 始终通过。只有 `scripts/session-fixture-layout.spec.ts` 能看出差异，而它的诊断指向 `bun run migrate:packed-session-fixtures`——[移除提案](../../proposed/process/2026-07-26-remove-packed-session-fixture-migrator.zh.md)将该命令描述为分支收敛残留。于是每次刷新都会写出布局检查拒绝的 fixture，这个过渡性迁移器成了刷新流程的必需步骤。

迁移器也无法完全修复第二种情况。写入器一旦从被 flush 切开的两行中剥掉 `time0`，两行之间的时间间隔就已丢失，重新解码会把两行都锚定在时间 0；对该 fixture 做规范化会以一个凭空产生的负间隔把它们合并。

## 决定

`scrubSessionSnapshot` 是唯一的已提交 fixture 投影，录制、刷新与比较都运行它。

它把每条正文记录解码为其所存储的逻辑事件——展开区间编码的 `sourceEventSeqs` 与打包 chunk 行——用 `packChunkRuns` 重新打包整个事件流，并在结果中省略 envelope。持久化记录按自身的 `seq`/`seq0` 与 `time`/`time0` 解码；已投影的 fixture 记录没有这些字段，改用其位置与时间 0，从而使该投影具备幂等性。会话 header 行保持逐字节不变。

该输出正是 `scripts/session-fixture-layout.ts` 所称的规范布局，因此写回不需要后续的 fixture 迁移。`normalizeSessionSnapshot` 与 `normalizeSessionSnapshots` 将该投影与 `normalizeSessionLog` 组合，不再单独持有比较侧的重打包步骤。

按每条记录自身的时间锚点重新打包，是写入器唯一不能与归零式归一化器共用的一点：已提交 fixture 在 `dt` 中携带真实的 chunk 间隔，而 flush 边界处的间隔只在两行仍携带 `time0` 时才存在。

## 测试

`scripts/session-fixture-layout.spec.ts` 用 JSONL 后端自有的 `eventLines` 编码器构造持久化日志，并断言写入器的输出是 `canonicalSessionFixture` 的不动点，覆盖单个持久化批次以及被切分到两个批次的 chunk run。`packages/test-support/session-snapshot/tests/normalize.spec.ts` 固定投影后的 provenance 列表、合并后的 flush 切分行、保留的间隔，以及对缺少会话 header 的日志的拒绝。

一次无密钥的 `bun run test:snapshot:refresh` 会把该 lane 拥有的每个 fixture 重写为其已提交字节，布局检查在没有迁移步骤的情况下覆盖仓库全部 171 个会话 fixture 并通过。这些 fixture 同样都是该投影的不动点，因此刷新其余 fixture 的 lane 也写出相同字节。

## 备选方案

**只展开 `sourceEventSeqs`，不动打包。** 已否决。这只封住了刷新恰好暴露出来的那种编码，留下 flush 边界编码，迁移器仍是必需环节，而它对该情况只能靠凭空产生一个时间间隔来修复。

**在写入器中复用比较侧的重打包。** 已否决。该辅助函数把每一行锚定在 `time0: 0`，会把所有 `dt` 归零；已提交语料记录的是真实间隔，因此一次刷新会把全部 171 个 fixture 重写成丢失间隔的版本。

**放宽规范布局以接受这些存储编码。** 已否决。语料与比较路径定义了何为规范，而区间编码是一种 JSONL 存储压缩：已经丢弃了 seq 与 time envelope 的 fixture，没有理由保留建立在它们之上的压缩。

**每次刷新后运行迁移器。** 已否决。这会把一个过渡命令变成永久流程步骤，而它对被 flush 切开的 run 的修复是有损的。

**在本次改动中删除迁移器。** 已否决，这是[移除提案](../../proposed/process/2026-07-26-remove-packed-session-fixture-migrator.zh.md)负责的独立决定；该命令仍用于转换本投影之前写出的 fixture。

## 影响

一个投影同时服务写入器与比较，因此在 JSONL 边界新增的存储编码只需在一处剥离。若遗漏某种新编码，两条路径会一起失败，而不会悄悄给出不一致的结果。

写回在投影时会校验打包行：畸形存储行会让刷新明确失败，而不是被复制进 fixture。首条记录不是会话 header 的日志（包括空日志）出于同样理由被拒绝。

布局检查保留了作为独立判据的价值：它现在确认的是写入器已经建立的性质，而不是描述写入器所需的一次修复。
