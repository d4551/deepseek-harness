---
description: "零依赖的有界 FIFO 准入控制，供需要限制并发工作量、又不能让被准入操作的结算相互耦合的能力持有者使用。"
kind: "package-reference"
---

# @deepseek-ai/dsh-capacity-gate

[English](README.md) | 中文

## 概述

`dsh-capacity-gate` 限制一个持有者同时运行多少个操作。调用方用 `acquire()` 取得一个名额，执行自己的工作，再通过闸门返回的幂等 release 归还名额。在闸门已满时到达的调用方按到达顺序排队，并以先进先出的顺序获得准入。闸门只推迟准入：它从不取消、结算或清理被准入的工作，因此共用一个闸门的两个操作保持各自独立的结算。取消有两种作用域——排队中的准入请求所带 `AbortSignal` 只拒绝该等待者，且该等待者不持有任何名额；而 `close(error)` 拒绝所有排队的等待者并拒绝之后的准入请求，这样正在释放的持有者就不会把调用方永远停在队列里。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发者备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

按经过校验的部署上限为每个持有者构造一个闸门，然后用闸门返回的 release 把每个被准入的操作包起来。

```ts
import { CapacityGate } from '@deepseek-ai/dsh-capacity-gate'

declare const maxConcurrent: number
declare const signal: AbortSignal
declare function runWork(): Promise<string>

const gate = new CapacityGate(maxConcurrent)

const release = await gate.acquire(signal)
try {
  const outcome = await runWork()
  void outcome
} finally {
  release()
}
```

`acquire` 在有空闲名额时立即兑现，否则排队。`signal` 只管辖等待过程：在上限之下，闸门直接发放而不读取它，因此尚未饱和的持有者的行为与完全没有闸门时一致，并保留自己的前置取消规则。一旦闸门满员，已经取消或在排队期间取消的调用方会以 `signal.reason` 中的 Error 拒绝；若 reason 不是 Error，则以描述该 reason 的 Error 拒绝。该调用方不持有任何名额。release 是幂等的，因此需要从多条终止路径归还名额的持有者——工作开始前的拒绝、工作自身的结算、以及显式释放——可以在每条路径上调用它。

### 释放持有者

```ts
import { CapacityGate } from '@deepseek-ai/dsh-capacity-gate'

declare const gate: CapacityGate

gate.close(new Error('holder disposed before the slot was granted'))
```

`close` 用该错误拒绝所有排队的等待者，之后的 `acquire` 调用也以同一错误拒绝。已经发放的名额仍归其持有者所有，它们的 release 依旧安全。

### 保持未饱和路径的原有行为

```ts
import { CapacityGate } from '@deepseek-ai/dsh-capacity-gate'

declare const gate: CapacityGate
declare const signal: AbortSignal

const release = gate.tryAcquire() ?? await gate.acquire(signal)
```

`tryAcquire()`只在闸门低于上限时取名额，且不让出事件循环；闸门满员或已关闭时返回 `undefined`。如果持有者调用的下游必须在调用方自己的 tick 中运行——例如某个 provider 在自身 start 期间安装取消监听器——就先走这条路径，这样在上限真正生效之前，加入闸门不会改变任何行为。

### 观察准入状态

`snapshot()` 返回 `{ limit, active, waiting }`：配置的上限、已发放且尚未归还的名额数，以及队列长度。当部署需要看到工作是在运行还是在排队时，持有者把它暴露出来。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `CapacityGate`（`tryAcquire`、`acquire`、`close`、`snapshot`）、`CapacityRelease`、`CapacitySnapshot` |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴生插件（无运行时不变量；队列代数由单元测试保证） |

### 为什么发放会与取消竞争

一次 release 会同步把名额发给队首等待者，而被发放的调用方要在一个 microtask 之后才恢复执行。落在这个窗口里的取消会发现自己的等待者已经离开队列，因此发放后的检查会重新读取该 signal，把名额交给下一个等待者，然后抛出。这样既保持了"被取消的准入绝不会带着名额去运行工作"这一承诺，又不会泄漏 release 已经交出去的那个名额。

### 计数与排队的区别

闸门自己预留名额，而不是从持有者自己的记录里推导计数。如果一个持有者的上限表现为拒绝而不是等待——计数达到上限时直接拒绝请求——它不需要队列，也就不使用本包。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [Subagent 缝](../../subagent/subagent/README.zh.md) —— 用这个闸门限制并发的一次性子 Agent run。
- [工作线程 workflow 引擎](../../workflow/workflow-worker-thread/README.zh.md) —— 限制单次脚本运行内并发的 `agent()` 调用。

-----

<a id="model-experience"></a>
## 模型体验

间接影响，通过准入模型可见工作的那些持有者体现，被推迟的准入只表现为其所等待的工具调用的延迟。

#### KV Cache 影响

无：闸门不贡献任何提示词文本，也不重排任何请求。

## 已知限制与待办

<a id="known-limitations-and-deferred-work"></a>

- **只管准入** —— 闸门只推迟启动，绝不停止已准入的工作；每个持有者仍然自己负责该名额下操作的取消与清理。
- **有空闲名额时不看 signal** —— 只有在调用方必须等待时才检查取消，因此持有者在未饱和路径上仍需自己的前置检查。
- **每个闸门只有一条扁平队列** —— 没有优先级、公平性分级或按所有者的子配额；需要这些的持有者应组合多个闸门。
- **上限在构造时固定** —— 需要更改上限的部署应重建持有者，而不是调整活动闸门的大小。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
