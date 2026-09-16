---
description: "JSON 存储后端：面向在配置根目录下选择、配置或排查整单元文件与逐记录文件的宿主与维护者。"
kind: "package-reference"
---

# @deepseek-ai/dsh-storage-json

[English](README.md) | 中文

## 概述

`dsh-storage-json` 在配置的根目录下把领域数据存为可读 JSON，并注册为后端 `json`。默认的 `single` 布局为每个单元保存一份完整的 `<unit>.json` 文件；`per-record` 布局为每条记录保存一份带版本戳的文档。两种布局都以原子方式发布每个变更文件，领域层负责安排调用顺序。当运维方需要可检查文件且所选布局适合写入量时选择它；对于更大或高并发的数据则选择 SQLite。本后端只面向宿主侧，不贡献提示词、工具或 schema。

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

当组合需要可读、可编辑的 JSON 存储时使用本包。把相关领域路由到 `json` 后端；每个领域规范选择 `single` 或 `per-record` 布局。

### 何时选择

小型单元需要一份完整、美化打印的文件时，选择默认的 `single` 布局。定点写入只应替换一份记录文档时，选择 `per-record`。当数据量大、写入频繁或多条记录需要事务更新时，选择 SQLite 后端。

### 配置

唯一的插件字段是 `root`，用于保存单元文件与目录。它是必填项，在构造后端时解析为绝对路径；后续工作目录变化不能重定向读写。后端按需以 `0o700` 模式创建根目录。领域规范选择其布局；本插件不提供布局覆盖项。

```yaml
- name: '@deepseek-ai/dsh-storage'
- name: '@deepseek-ai/dsh-storage-json'
  config:
    root: /var/lib/dsh/data
- name: '@deepseek-ai/dsh-storage-domain'
  config:
    backend: json
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | 必填 | 保存 `<unit>.json` 文件与 `<unit>/` 目录树的目录；按需以 `0o700` 创建 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-storage-json)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 可观察行为

缺失的 `single` 文件会作为空单元打开，并在第一次写入时物化。`per-record` 单元在每次读取或修改前检查初始化；没有可用导入源的空读取不物化目录树，以便稍后读取修正的源文件。首次修改会确立持久的目录树权威状态。在 `single` 中，畸形内容以 `malformed-medium` 拒绝，不同的已存版本以 `version-mismatch` 拒绝。在 `per-record` 中，每份畸形、不可读、版本不同或已删除的记录都读作不存在，因此单份坏记录文档不会使单元被拒绝。记录键必须匹配 `[a-zA-Z0-9_-]+`；不安全的键在任何文件操作前被拒绝。每次已完成的写入都已持久化，关闭后的操作以 `closed` 拒绝。

整单元文档只采用 `tables` 自身的条目；已声明的表若没有已存条目，就作为空表打开，即使表名是 `constructor` 也如此。记录值保留原生 JSON 解析语义，包括名为 `__proto__`、`constructor` 和 `prototype` 的自有键。

在 `single` 中，`loadAll()` 读取最近一次成功发布的状态。尚未完成或已拒绝的写入不会改变该状态；关闭单元会等待尚未完成的发布，再释放单元供再次打开。调用方必须串行执行同一单元的写入；领域层负责提供这一顺序保证。

`JsonStorageBackend.close()` 拒绝新的打开请求，并等待尚未完成的 `kv.open()` promise 全部结束后才完成自身。如果关闭开始时某个单元仍在打开中，成功初始化的单元会被关闭而不返回给调用方，其打开请求以 `closed` 拒绝。关闭还会关闭现有单元，并排空它们尚未完成的写入。

插件释放时先撤下后端的生命周期服务，并等待依赖领域排空其已排队的写入，然后注销后端并关闭其单元。整个组合被释放时也遵循这一顺序。

未初始化的 `per-record` 目录树可以从有效的 `<root>/<unit>.json` 整单元文档导入其已声明表。每个已存的声明表都必须是对象，每个导入键都必须满足与直接写入相同的路径安全规则。所有校验在发布前完成，源文件保持不变。持久化初始化记录在开始写入记录前捕获完整导入快照；即使源文件改变，中断的导入仍从该快照恢复。读取与直接修改等待初始化完成，关闭会排空初始化。无效的初始化元数据会使访问被拒绝。

已初始化的目录树在所有记录被删除后仍是权威状态。无标记目录树的已声明表中存在文档路径，或存在已声明的 `global.json`，即使不可读或版本陈旧，也会确立该权威状态。删除发布明确表示不存在的文档；后续 put 用记录数据替换它们。初始化记录与祖先目录持久化可防止保留的导入源重新填充已成功清空的单元。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

两种布局共享原子发布机制，但以不同方式确定状态所有权。`single` 拥有一份内存单元投影；`per-record` 把目录树视为权威状态。

### 设计理念

- **`single` 公开已提交的内存状态。** 每次写入构造独立的候选状态，先发布其完整的 `<unit>.json` 文档，再让该状态可供读取。发布失败时，可读状态保持不变。
- **`per-record` 以目录为权威状态。** 每次 put 或 delete 都会更改一个 `<unit>/<table>/<key>.json` 文档，`loadAll()` 则重新读取已初始化的目录树。每份文档都带有单元版本戳，以及记录值或明确的删除标记。
- **每次调用都持久发布。** 写入在替换前先同步同目录下的暂存文件。POSIX 使用 `rename()`，随后 fsync 父目录；Windows 使用[共享发布辅助函数](../../util/atomic-write/src/win32.ts)，并传入 `MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH`。领域层写入链负责安排跨调用的顺序。

### 文件格式

`single` 文档携带单元标识、全局单例与所有表：

```json
{
  "unit": { "name": "workspace", "version": 1 },
  "global": null,
  "tables": { "workspaces": { "<key>": { "path": "/work/demo" } } }
}
```

`per-record` 表文档位于 `<root>/<unit>/<table>/<key>.json`，形式为 `{ "version": 1, "record": <value> }` 或 `{ "version": 1, "deleted": true }`；可选的全局值使用 `<root>/<unit>/global.json`。格式版本来自领域规范。`<unit>/.initialization.json` 记录已捕获且正在进行的导入或其完成状态，与存活记录数量无关。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：后端注册、`root` 配置、单元打开／关闭表 |
| [`src/unit-lifecycle.ts`](src/unit-lifecycle.ts) | 两种布局共享的开放槽生命周期：关闭守卫、写入排空、已声明 global 检查 |
| [`src/single-unit.ts`](src/single-unit.ts) | 一个 `single` 单元：已提交状态读取与候选状态发布 |
| [`src/per-record-unit.ts`](src/per-record-unit.ts) | 一个 `per-record` 单元：目录树读取、路径安全记录与单文档写入 |
| [`src/initialization.ts`](src/initialization.ts) | 目录树持久权威状态与已捕获导入的恢复 |
| [`src/durable-directory.ts`](src/durable-directory.ts) | 创建目录并持久化祖先目录 |
| [`src/format.ts`](src/format.ts) | 带版本校验的整单元与记录序列化 |
| [`src/atomic.ts`](src/atomic.ts) | 原子文件替换：临时文件写入、fsync、rename、目录 fsync |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式：正确性靠往返持久性） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当本后端视角不够用时阅读以下页面：子系统参考是权威约定，兄弟后端展示了另一种介质。

- [存储子系统](../../../docs/subsystems/storage.zh.md)——后端约定、领域语义与生成的 API。
- [存储包映射](../README.zh.md)——家族的各包及其在仓库中的位置。
- [SQLite 存储后端](../storage-sqlite/README.zh.md)——面向高频数据的定点更新介质。
- [领域 KV 存储 Agent Note](../../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)——后端家族背后的设计及其延期工作。

-----

<a id="model-experience"></a>
## 模型体验

### 已存领域记录

#### 模型看到什么

无。本后端不贡献提示词、工具或 schema；它在 `ctx.storage` 后面持久化非会话领域数据，只供宿主侧消费方使用。

#### Token 影响

实时请求 token 为零。

#### KV Cache 影响

无：本后端从不触碰实时请求前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明本后端何时不合适，或何时需要特别的运维注意。它们是当前包约束，不是任务积压。

- **`single` 会重写整个单元**——每次写入都重新发布完整单元文件；当此成本过高时，使用 `per-record` 或把领域路由到 SQLite。
- **没有跨进程写锁**——两个进程写入同一单元时可能交错执行替换；对同一文件的写入以最后完成者为准。
- **删除会为每个键保留一份小型不存在文档**，直到后续 put 替换它；删除这些文件需要独立的持久删除协议。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

Agent Note 把整单元重写的规模前提标记为风险：如果在被路由到 SQLite 之前，第二个消费方以千条记录规模落到本后端，重写成本会比预期更早显现。缓解办法是配置——把 `routes` 指向 SQLite 后端——而不是修改本包。

</details>
