---
description: "面向不得对同一目标交错执行两次修改的文件系统后端的、零依赖按键操作串行化。"
kind: "package-reference"
---

# @deepseek-ai/dsh-keyed-lock

[English](README.md) | 中文

## 概述

每个键同一时刻只运行一个操作，该键上后续的调用方按到达顺序排队，而不同的键并发运行。它之所以存在，是因为每个 `ctx.fs` 后端都需要这一保证，而它们各自都写了一遍：`fs-local`、`fs-e2b` 与 `fs-network-drive` 持有同一套 promise 链算法的三份副本。队列在首次使用时创建、排空后丢弃，因此只触碰大量键各一次的进程不会保留任何内容。

## 目录

- [使用本包](#use-this-package)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

按键串行化操作。每个键同一时刻只运行一个操作，该键上后续的调用方按到达顺序排队等待，而不同的键之间并发运行。

## 为什么需要它

文件系统后端不能同时对同一个目标运行两次修改：交错执行的读-改-写会丢失其中一次写入。每个 `ctx.fs` 后端都需要这一保证，而它们各自都写了一遍——`fs-local`、`fs-e2b` 和 `fs-network-drive` 持有同一套 promise 链算法的三份副本。一个拥有者取代了它们。

## 使用

```ts
import { KeyedLock } from '@deepseek-ai/dsh-keyed-lock'

declare const targetKey: string
declare function read(key: string): Promise<string>
declare function edit(current: string): string
declare function write(key: string, next: string): Promise<string>

const locks = new KeyedLock()
const version = await locks.run(targetKey, async () => {
  const current = await read(targetKey)
  return write(targetKey, edit(current))
})
```

`run(key, operation)` 以 `operation` 产生的结果原样兑现或拒绝。拒绝只到达它自己的调用方：该键上排队的下一个操作照常运行，因此一次失败的写入不会卡住这个键。

队列在首次使用时创建，排空后即被丢弃，因此只触碰大量键各一次的进程不会保留任何内容。`size` 报告当前有操作在其上的键数量，这也是该包测试所断言的对象。

## Model Experience

间接地，通过对写入进行串行化的文件系统后端体现：排队中的操作只表现为某次工具调用的延迟，它正等在对同一文件的更早一次写入之后。

#### KV Cache effect

无：该锁不贡献任何提示词文本，也不重排任何请求。


## Known Limitations and Deferred Work
- **键是按精确匹配比较的字符串。** 同一路径的两种写法就是两个键。需要路径同一性的调用方应在加锁前完成规范化；`dsh-fs` 后端传入的是自身 `resolve()` 铸造的带牌 `FsTargetKey`，它已经是规范形式。
- **没有超时、没有取消、也不可重入。** 永不兑现的调用方会永久持有其键，而在已持有某键时再次对该键调用 `run` 会死锁。这两点都源于它所服务的调用方的性质：每个操作都是有界的文件系统写入；需要被放弃的队列则需要另一种原语。
- **除到达顺序外没有公平性。** 不存在优先级；持续负载下的某个键按调用方到达的顺序服务，而不按任何权重。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 —— 点击展开</summary>

无。

</details>
