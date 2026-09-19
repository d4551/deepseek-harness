---
description: "Thrown 拒绝值联合类型，供观察 throw 或 Promise 拒绝的处理方使用，并说明何时应标注它。"
kind: "package-library"
---

# @deepseek-ai/dsh-thrown

[English](README.md) | 中文

## 概述

`dsh-thrown` 用其 `Thrown` 联合类型命名 throw 或 Promise 拒绝臂可能传递的值的全集：`object` 覆盖 `Error` 实例与一切结构化值，六种原始类型覆盖调用方作为字面量抛出的值，`null`/`undefined` 覆盖裸拒绝。处理方在观察到值的边界处标注该类型——`catch` 参数、`.catch` 回调、记录下来的失败——而不是收窄为 `Error` 并悄悄排除运行时实际可能传递的值。它是纯类型包，没有运行时代码，也不依赖其他 harness 包，因此任何包都可以命名自己捕获到的值，而无需导入不相关的能力包。观察拒绝的包——结算清理、持久化屏障、传输关闭、审批槽位——在观察处用 `Thrown` 标注，仅在处理方有证据支持更小形态的位置才收窄为 `Error` 或领域形态。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在包观察到拒绝的边界处用 `Thrown` 标注；绝不在本地重新声明该联合类型。记录或转发捕获值的处理方保留完整的值，仅在处理方有证据支持更小形态的位置做收窄。

### 标注一次观察

导入该联合类型，并标注 `catch` 参数或记录下来的失败：

```ts
import type { Thrown } from '@deepseek-ai/dsh-thrown'

async function disposeManagedProcesses(): Promise<void> {
  const failures: Thrown[] = []
  const recordFailure = (error: Thrown): void => {
    failures.push(error)
  }
  // ... await work with .then(undefined, recordFailure) ...
  if (failures.length > 1) throw new AggregateError(failures, 'teardown failed')
}
```

该标注在编译期被擦除。一旦被观察到，值就作为普通值流经处理方：记录、转发、聚合与渲染都不需要任何特殊处理。

### 何时标注

在观察到值的位置标注——`catch` 参数、拒绝回调、记录失败的集合，以及接受拒绝所传递的任意值的函数（如消息格式化函数）。不要标注包自己构造的值：只抛出 `Error` 实例的函数保持自己精确的类型；共享联合类型的成本只付在另一侧站着任意抛出者的位置。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节 —— 点击展开</summary>

该联合类型是一个直接别名：`object | string | number | boolean | bigint | symbol | null | undefined`，覆盖 JavaScript 中可以抛出的所有值。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | `Thrown` 联合类型 —— 本包的全部 |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生（无运行时不变式；覆盖由编译器保证） |

### 为何该联合类型是完备的

JavaScript 对 `throw` 的操作数或 `Promise.reject` 的参数没有任何限制，因此该联合类型必须接受语言中的所有值：`object` 覆盖 `Error` 实例与一切结构化值，六种原始类型成分覆盖字面量抛出，`null`/`undefined` 覆盖裸拒绝。在观察边界处的更窄标注是处理方无法证明的主张；收窄属于有证据的位置。

### 为何保持零依赖

把 `Thrown` 放在独立的包中，意味着传输层、存储或 UI 槽位可以命名自己捕获到的值，而无需为了触及词汇表去导入不相关的能力包；拒绝词汇表恰好有一个所有者。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

在需要该词汇表所命名的拒绝处理或周边类型约定时阅读以下页面。

- [Core 子系统](../../../docs/subsystems/core.zh.md) —— 共享的 agent/会话生命周期与类型规则文档位置。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 —— 点击展开</summary>

None.

</details>
