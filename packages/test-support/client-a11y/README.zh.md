---
description: "在真实浏览器中运行 axe-core 无障碍审计，供测试作者依 WCAG 2.2 A/AA 检验已渲染的 UI。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-a11y

[English](README.md) | 中文

## 概述

`dsh-client-a11y` 按 WCAG 2.0、2.1、2.2 的 A、AA 级及 axe 最佳实践规则审计已渲染的 client 组件。Chromium 使用产品主题计算布局、对比度与伪元素。报告包含违规、已判定检查数，以及带诊断数据的未判定检查。固定规则集适用于每个受审组件。

## 目录

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

运行 `bunx vitest run --config vitest.client-browser.config.ts packages/test-support/client-a11y` 验证浏览器审计引擎。浏览器通道发现导入本包的 client 套件，以及名为 `*.browser.spec.ts` 或 `*.browser.spec.tsx` 的文件。无需布局的单元套件使用 jsdom；独立像素回归测试验证其已安装的原生 `canvas` peer。

渲染一个 surface（受审面）、审计它，并用 `accessibilityFailures` 守住下限：

```text
const { baseElement } = render(<main><Button>Send</Button></main>)
const audit = await auditSurface('Button', baseElement)

expect(accessibilityFailures([audit], 100)).toBe('')
expect(audit.incomplete).toEqual([])
```

`auditSurface(surface, context)` 返回违规、`passed`、`failed`、`undecided` 节点计数、`undecidedRules` 和完整的 `incomplete` 结果。`accessibilityFailures(audits, 100)` 拒绝空审计集、未判定任何检查的受审面、违规节点、未判定检查和低于 100 的分数。对 `incomplete` 的断言会输出完整诊断数据。`accessibilityScore(audits)` 衡量已判定检查；`formatViolations(audit)` 标明每条违规规则及受影响元素。

### 在 landmark 内渲染

页面结构类规则无法由一个漂浮在空 `<body>` 中的组件满足。请把每个 surface（受审面）渲染进真实页面会提供的 landmark 中——一个 `<main>` 包裹层即可——这样审计报告的是组件缺陷，而不是测试脚手架自身缺少页面框架。

### 推导受审集合

手写的受审组件清单会在下一个组件出现时悄悄失去覆盖。请从包自身的导出推导该集合，并断言受审名称集合等于导出名称集合，这样新组件或新图标一交付即被审计。

### 可能出什么问题

- **检查报告为未判定**——查看 `incomplete` 中的受影响节点和原因。重叠文字、遮挡动画或未确定的图片背景即使在浏览器中也可能阻止判定。修复渲染状态后重新审计。
- **portal 出去的 surface（受审面）逃出了 landmark**——渲染进 `document.body` 的内容位于包裹层之外。请赋予它实际具有的 role（模态浮层就是 `dialog`），而不是排除该规则。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

### 设计

该模块是对 `axe.run` 的一层薄而诚实的投影。它固定标签清单，请求 violations、passes 与 incomplete 结果，并把 axe 的按规则节点数组转换为计数。incomplete 结果被单独报告并排除在分数之外：把未判定的检查算作任何一侧都会歪曲审计结果。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `CLIENT_AXE_TAGS`、`clientAxeRunOptions`、`auditSurface`、`accessibilityFailures`、`accessibilityScore`、`formatViolations` |
| [`src/invariant.ts`](src/invariant.ts) | 不变式伴生插件（无运行时不变式；该模块不拥有事件流或可变数据） |

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [UI primitives 包](../../client/ui-primitives/README.zh.md)——受审组件集合及其无障碍套件。
- [Client 测试运行时](../client-runtime/README.zh.md)——渲染功能 surface（受审面）的 jsdom 测试台。
- [测试策略](../../../docs/testing.zh.md)——无障碍层级及其周边通道。
- [test-support 分组导览](../README.zh.md)——同级测试脚手架与支撑包。

-----

<a id="model-experience"></a>
## 模型体验

无，因为本包是浏览器侧测试基础设施；此处没有任何内容会进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制界定了该审计能力的消费方式。它们是当前的包级约束，而非任务待办。

- **自动检查仅覆盖部分无障碍要求**——键盘操作流程、屏幕阅读器行为和内容可理解性还需要交互审查。
- **一次只审计一个 surface（受审面）**——该模块审计调用方已渲染好的 DOM 子树。它不挂载任何东西，也不了解 slot，因此由套件决定什么算一个 surface 以及如何构建它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
