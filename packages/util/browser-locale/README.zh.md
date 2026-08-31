---
description: "在语言环境服务就绪之前即已绘制的启动界面所共用的浏览器语言偏好规则，以及界面何时自带词典的策略。"
kind: "package-library"
---

# @deepseek-ai/dsh-browser-locale

[English](README.md) | 中文

## 概述

`dsh-browser-locale` 为那些在语言环境服务存在之前就渲染的界面回答一个问题：浏览器请求的是产品所提供的哪一种语言。它按偏好顺序读取 `navigator.languages`，回退到 `navigator.language`，把地区标签视为其语言，因此 `zh-CN`、`zh-Hant` 和 `zh` 都选择中文；当运行环境没有 `window`，或请求的语言产品并未提供时，答案是英文。它自身不带任何依赖，因此正在等待插件树的启动外壳无需加入该树即可使用它。每个界面仍然自己拥有文案词典；它们共享的只是这条偏好规则。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)
- [已知限制与待办](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当某个界面需要在语言环境服务可用之前绘制自己的文案时使用它。词典留在负责渲染的界面中，只从这里取用解析结果。

### 解析浏览器请求的语言

```ts
import { resolveBrowserLocale } from '@deepseek-ai/dsh-browser-locale'
import type { BrowserLocaleId } from '@deepseek-ai/dsh-browser-locale'

interface BootCopy { readonly loading: string }
const DICTIONARIES: Record<BrowserLocaleId, BootCopy> = {
  en: { loading: 'Loading' },
  zh: { loading: '加载中' },
}

/** Boot copy for one locale; omitted, the browser decides. */
export function bootCopy(locale: BrowserLocaleId = resolveBrowserLocale()): BootCopy {
  return DICTIONARIES[locale]
}
```

### 显式传入标签

测试与非浏览器调用方直接传入标签，而不让模块读取浏览器：

```ts
import { resolveBrowserLocale } from '@deepseek-ai/dsh-browser-locale'

const locale = resolveBrowserLocale(['fr', 'zh-CN', 'en'])
```

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 —— 点击展开</summary>

### 源码索引

| 文件 | 角色 |
|---|---|
| [`src/index.ts`](src/index.ts) | `BrowserLocaleId` 与 `resolveBrowserLocale` —— 本包的全部内容 |
| [`src/invariant.ts`](src/invariant.ts) | 不变量伴随插件（无运行时不变量；标签匹配由单元测试保证） |

### 没有 window 的运行为何回答英文

`navigator` 在浏览器之外也存在于宿主全局对象上，并报告机器的语言。服务端或 Worker 宿主的运行不得让页面语言取自操作系统，因此本模块仅在 `window` 有定义时才采信浏览器。

### 为何保持零依赖

启动外壳在任何插件加载之前就已绘制，因此它无法依赖自己正在等待的语言环境服务。把这条规则放在自身没有依赖的包中，使该外壳仍然能够共享它。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [客户端 locale 包](../../client/locale/README.zh.md) —— 插件树运行后拥有文案的语言环境服务。
- [国际化文档](../../../docs/i18n/README.zh.md) —— 本仓库如何处理双语内容。

-----

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者的工作背景 —— 点击展开</summary>

无。

</details>

-----

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与待办

- 所提供的语言集合固定为 `en` 与 `zh`，与产品提供的文案一致。新增第三种语言会改变本模块的类型以及每一个以它为键的词典，因此该集合只会被有意地变更，而不通过配置调整。
- 只有语言子标签起作用。`zh-Hant` 与 `zh-Hans` 都会选中简体中文词典，因为产品只提供一套中文文案；要按书写系统区分，先要有第二套词典，然后才谈得上在这里加规则。
