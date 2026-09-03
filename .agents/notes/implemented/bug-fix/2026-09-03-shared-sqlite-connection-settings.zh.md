# Agent Note: 共享的 SQLite 连接设置

Status: implemented

[English](2026-09-03-shared-sqlite-connection-settings.md) | 中文
## Problem

有两个包会打开 SQLite 数据库，而其中只有一个对连接做了加固。

[`session-persistence-sqlite`](../../../../packages/session/session-persistence-sqlite/README.zh.md) 会设置 `trusted_schema = OFF`、`mmap_size = 0`、`synchronous = FULL`，逐项读回，并在 SQLite 报告的值不同时拒绝打开；它还带有忙等待超时，并在切换 journal 模式时等待竞争写入者让出。[`storage-sqlite`](../../../../packages/storage/storage-sqlite/README.zh.md) 只设置了 `foreign_keys`、`journal_mode` 和一次 `user_version` 检查，此外什么都没有。

其中起决定作用的是 `trusted_schema = OFF`。该设置为开启状态时，打开一个其他账户可写的数据库文件，会让该文件中的视图、触发器和索引表达式在打开时执行 SQL 函数。存储中枢持有工作区注册表和设置文档，因此每次启动都会打开 Harness home 下的文件。

`storage-sqlite` 的 README 把这一缺口描述为一项待整理的重复：“`openDatabase` 复刻了 session-persistence 的 SQLite 打开序列；提取到共享中间层的工作推迟到计划中的会话后端迁移。”这句话在关键方向上是错的。该序列并没有复刻会话那一套，而是一个严格更弱的子集，读 README 的人得不到任何线索去寻找缺失的安全控制。

## Decision

[`@deepseek-ai/dsh-sqlite-connection`](../../../../packages/util/sqlite-connection/README.zh.md) 拥有这些设置。两个后端都通过它应用设置，于是 Harness 的 SQLite 连接只有一处定义，也只有一处需要修改。

每项设置在应用后都会被读回，SQLite 未按请求报告的值会导致打开失败。因此，静默忽略某个 pragma 的构建无法提供一个仅仅看起来已加固的连接。pragma 语句是该模块中的固定常量；没有调用方为它们提供 pragma 文本，因此任何调用点都无法通过传入不同字符串来削弱某项设置。

忙等待超时是唯一随调用方变化的值。它是每个消费包自身 `Config` 上的受校验字段，上界为 `MAX_BUSY_TIMEOUT_MS`——SQLite 的有符号毫秒上限——而不是共享模块中的常量，因为会话日志与存储中枢的争用程度不同。

`journal_mode` 留在各后端。它是每个数据库的物理选择，而非连接设置，且两个包选择了不同的模式。

## Alternatives considered

**把缺失的 pragma 复制进 `storage-sqlite`。** 这能以更小的改动堵上同一个洞，也正是 README 中那句“推迟”长期以来所描述的做法。但它同时会复现最初的故障：两套必须同步修改的打开序列，且没有任何机制迫使第二套跟随第一套。此后 `bun run duplication` 会把这份复制报告为克隆。

**让 `storage-sqlite` 直接使用会话包的 `openDatabase`。** 该函数接受注入的 `DatabaseSync` 构造器，并执行存储中枢并不具备的 schema 归属检查，于是存储侧的调用方将不得不传入描述会话数据库的参数。

**不共享这些设置，改为记录差异。** 该差异原本就已被记录，只是记录得不准确，而“被记录”本身并没有让它变得可见。两个并列值之间没有解释的不对称是一次遗漏的提取，而不是一项需要记录的事实。

## Consequences

存储中枢现在会拒绝打开无法完成连接加固的数据库，而此前它会静默打开。若某个部署的 SQLite 构建不支持其中某项 pragma，打开会失败并指明是哪一项设置，而不是在无保护状态下运行。

两个后端都获得了此前未暴露的 `busyTimeoutMs`，存储中枢也获得了 journal 模式重试，因此模式切换期间的竞争写入者现在会等待，而不是让打开失败。

两套打开序列不会再各自漂移：对 schema 信任、内存映射或提交同步的修改会同时到达两个消费方，而任何一方若长出自己的副本，`bun run duplication` 都会失败。
