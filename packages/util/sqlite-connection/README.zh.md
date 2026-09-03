---
description: "每个 Harness 数据库后端都应用并校验的属主独有路径准备与 SQLite 连接设置：排他地创建文件、关闭 schema 信任、关闭内存映射、synchronous FULL，以及会等过竞争写者的 journal 模式切换。"
kind: "package-reference"
---

# @deepseek-ai/dsh-sqlite-connection

[English](README.md) | 中文

## 概述

`dsh-sqlite-connection` 拥有 Harness SQLite 连接在后端使用之前必须保持的设置：schema 信任关闭、内存映射关闭、`synchronous=FULL`，以及连接实际报告的 journal 模式。每个设置都是先应用再读回，因此一个接受了 pragma 却悄悄保留旧值的 SQLite 构建会让打开失败，而不是交出一个后端以为已经加固的连接。这些设置的 pragma 文本固定在本包内部；后端只需提供自己的 journal 模式语句与 busy 截止时间。它还拥有每个连接之前的那一个文件系统步骤：以属主独有权限创建数据库文件及其父目录。它是一个零依赖库，由 session 持久化与 storage 的 SQLite 后端共享，因此两者持有同样的保证；它不打开连接，也不知道这两个包各自的 schema。

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

打开 SQLite 数据库的后端先准备自己的路径，再按顺序在自身的 schema 工作前后调用这三个连接步骤，然后保留句柄。

```ts
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'
import {
  configureConnectionSecurity,
  configureDurability,
  prepareDatabasePath,
  selectJournalMode,
  type SqliteDatabaseSubject,
} from '@deepseek-ai/dsh-sqlite-connection'

declare const path: string
declare const busyTimeoutMs: number
declare function validateSchema(db: DatabaseSync): void

const actual = await prepareDatabasePath(path)
const database: SqliteDatabaseSubject = { path: actual, role: 'storage database' }
const deadline = performance.now() + busyTimeoutMs
const db = new DatabaseSync(actual, { timeout: busyTimeoutMs })
try {
  configureConnectionSecurity(db, database)
  validateSchema(db)
  await selectJournalMode(db, database, {
    statement: 'PRAGMA journal_mode = WAL',
    mode: 'wal',
    deadline,
  })
  configureDurability(db, database)
} catch (error: unknown) {
  db.close()
  throw error
}
```

### 连接前先准备路径

`prepareDatabasePath(path)` 解析路径、以 `0o700` 模式创建其父目录、并以 `wx` 与 `0o600` 模式创建数据库文件本身，然后返回要打开的路径；`:memory:` 不指向任何文件系统条目，原样透传。已存在的文件保留自己的模式，`EEXIST` 之外的任何错误都向上传播。需要在这些步骤之间检查路径的后端——校验属主或拒绝符号链接父目录——在自己的检查之后自行调用 `createDatabaseFile(path)`。

### 按这个顺序执行步骤

`configureConnectionSecurity` 必须最先执行，先于任何可能触达视图、触发器或索引表达式的语句：在 schema 信任开启时，打开一个其他主体可写的数据库文件会运行这些对象所指名的函数。`configureDurability` 必须最后执行，在 journal 模式切换之后，这样 SQLite 报告的级别才是连接保持的级别。每个调用在连接未兑现的第一个设置上抛出，由调用方关闭句柄——失败的序列绝不能留下一个仍在使用的半配置连接。

### 给竞争写者的等待设界

`DEFAULT_BUSY_TIMEOUT_MS`（5,000）与 `MAX_BUSY_TIMEOUT_MS`（2,147,483,647，SQLite 有符号毫秒接口接受的最大值）是后端自身经过校验的 `busyTimeoutMs` 配置字段的共享边界。把同一个值作为 `timeout` 传给驱动、并传入 journal 截止时间：SQLite 对排他的 journal 模式切换回答 `SQLITE_BUSY` 而不是等待连接的 busy 超时，因此 `selectJournalMode` 自己重试那一条语句，直到截止时间过去。

### 读回设置

`readConnectionSettings(db)` 返回连接实时报告的 `{ trustedSchema, mmapSize, synchronous }`。后端及其测试用它作为连接已配置的证据；它读取的是文件支撑的连接，因为进程内数据库对 `PRAGMA mmap_size` 根本不返回行。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现 internals — 点击展开</summary>

### 源码地图

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | 路径准备、三个配置步骤、`readConnectionSettings`、busy 超时边界与连接类型 |
| [`src/invariant.ts`](src/invariant.ts) | Invariant 伴生（无运行时 invariant；设置位于调用方的连接上） |

### 为什么每个设置都要读回

`PRAGMA` 是请求，不是承诺：SQLite 解析未知或不支持的 pragma 不会报错，并返回它实际保留的值。一个强制开启 `SQLITE_TRUSTED_SCHEMA` 的构建、忽略 `mmap_size` 的驱动、或拒绝 WAL 切换的文件系统，否则会让后端记录一个它并不持有的保证。读回值把每一种情形都变成一次点名设置与数据库的响亮打开失败。

### 为什么 journal 切换要重试

journal 模式变更需要排他锁。SQLite 对它立即返回 `SQLITE_BUSY` 而不会调用连接的 busy 处理器，因此同一时刻另一个进程打开同一个数据库时，会让一次本应由配置的 busy 超时覆盖的打开失败。重试以 10 毫秒间隔推进并在调用方的截止时间停止，使总等待保持在与其他争用语句相同的边界内。

### 哪些留在后端

校验路径属主、拒绝符号链接父目录、选择哪些 journal 模式足够持久可接受、以及拥有 schema，都留在后端。除以属主独有权限创建文件及其父目录之外，本包只看到一个已打开的连接和一个放进失败消息的名字。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [SQLite 会话持久化](../../session/session-persistence-sqlite/README.zh.md) — 消费这些设置的会话后端。
- [SQLite 存储后端](../../storage/storage-sqlite/README.zh.md) — 消费这些设置的 storage-hub 后端。
- [共享 SQLite 连接设置 Agent Note](../../../.agents/notes/implemented/bug-fix/2026-09-03-shared-sqlite-connection-settings.zh.md) — 为什么由一个拥有者持有它们。

-----

<a id="model-experience"></a>
## 模型体验

无。本包只准备宿主侧数据库路径与连接，不注册任何面向模型的内容。

#### KV Cache 影响

这里没有任何内容进入请求前缀，因此 provider 缓存复用不受影响。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **设置是连接局部的** — 它们都不持久化在数据库文件里，因此其他代码在同一文件上打开的连接不持有其中任何一项；每个打开者都要自行应用。
- **不评判请求的 journal 模式** — 校验只证明连接报告了调用方要求的模式；拒绝 `memory` 或 `off` 这类非持久模式留在各后端经过校验的配置中。
- **`readConnectionSettings` 需要文件支撑的连接** — 进程内数据库不返回 `PRAGMA mmap_size` 行，因此读取进程内连接的调用者应直接查询它关心的设置。
- **不做路径校验** — symlink 与属主检查属于后端；面对一个其他主体可写的父目录，属主独有创建也会落败，而通向一个其他主体可替换文件的加固连接，仍然是一个其他主体可替换的文件。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
