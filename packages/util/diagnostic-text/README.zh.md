---
description: "把 TypeScript 诊断消息链拍平成一个字符串；以结构化方式描述该链，使两个编译面都无需依赖对方即可使用。"
kind: "package-library"
---

# @deepseek-ai/dsh-diagnostic-text

[English](README.md) | 中文

## 概述

`dsh-diagnostic-text` 把一条 TypeScript 诊断变成读者看到的句子。编译器用嵌套的 `messageChain` 而非平铺文本来解释诊断，因此每一个要打印它的界面都必须以同样的方式遍历并拼接这条链。本包就是这次遍历。它以结构化方式描述该链 —— 一个 `text` 与一个可选的 `messageChain` —— 而不是导入编译器自己的 `Diagnostic`，因此它没有任何依赖，本仓库的两个编译面都可以直接把各自的诊断传进来。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

凡是编译器诊断要变成供人阅读的文本之处都可以使用它：某个门禁的失败输出、分析器错误、报告。

```ts
import { flattenDiagnosticMessage } from '@deepseek-ai/dsh-diagnostic-text'

const message = { text: 'Type A is not assignable to type B', messageChain: [{ text: 'Property x is missing' }] }
const rendered = flattenDiagnosticMessage(message, '\n')
```

已经是普通字符串的诊断会原样返回，因此持有 `string | Diagnostic` 的调用方无需自己再分支。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

### 源码索引

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `DiagnosticMessage` 与 `flattenDiagnosticMessage` —— 本包的全部内容 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴随插件（无运行时不变量；链拼接由单元测试保证） |

### 为何以结构化方式描述该链

导入编译器的 `Diagnostic` 会把本包绑定到某一个编译器入口，并给每个使用方引入一项依赖。遍历所读取的只有一个 `text` 加一个可选的 `messageChain`，而真实的诊断在结构上正好满足它。

### 为何空链无需分支

拼接只有一个元素的列表返回的就是该元素，因此缺失或为空的链本身就只产出那段文本。曾经守卫它的提前返回是一个没有自身行为的分支。

</details>

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

该遍历只读取 `text` 与 `messageChain`。诊断的类别、编号与文件位置属于报告它们的界面，由该界面与这句话并列地格式化，而不是放进这句话里。

-----

<a id="further-exploration"></a>
## 进一步探索

- [开发文档](../../../docs/development.zh.md) —— 本仓库的 TypeScript 工程布局及其两个编译面。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作背景 —— 点击展开</summary>

无。

</details>
