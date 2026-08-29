---
description: "面向 jsdom client 测试通道的 axe-core 无障碍审计，供测试作者依 WCAG A/AA 检验已渲染的 UI。"
kind: "package-library"
---

# @deepseek-ai/dsh-client-a11y

[English](README.md) | 中文

## 概述

`dsh-client-a11y` 对 client 套件已渲染出的 DOM 运行 axe-core，并报告其发现：被违反的规则、通过与失败的规则-节点检查数，以及套件所审计的全部 surface（受审面）上的一个聚合分数。规则集在此固定——WCAG 2.0 与 2.1 的 A、AA 级加 axe 的最佳实践标签——因此没有任何套件能收窄自身被检验的标准。它是独立的包而非 [`dsh-client-test-runtime`](../client-runtime/README.zh.md) 的一部分，因为 axe-core 在加载时会触碰 jsdom 的全局对象：把它导入共享测试台会让它出现在每个 client spec 之前，并改变无关测试的布局测量结果。

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

渲染一个 surface（受审面）、审计它、断言没有违规，并守住聚合分数：

```text
const { baseElement } = render(<main><Button>Send</Button></main>)
const audit = await auditSurface('Button', baseElement)

expect(formatViolations(audit)).toBe('')
expect(accessibilityScore([audit])).toBeGreaterThanOrEqual(99)
```

`auditSurface(surface, context)` 返回被违反的规则，以及 `passed`、`failed`、`undecided` 三个节点计数。`accessibilityScore(audits)` 是*已判定*检查中通过的百分比；`formatViolations(audit)` 为每个违规节点渲染一行，写明规则、其影响级别与对应元素。

### 在 landmark 内渲染

页面结构类规则无法由一个漂浮在空 `<body>` 中的组件满足。请把每个 surface（受审面）渲染进真实页面会提供的 landmark 中——一个 `<main>` 包裹层即可——这样审计报告的是组件缺陷，而不是测试脚手架自身缺少页面框架。

### 推导受审集合

手写的受审组件清单会在下一个组件出现时悄悄失去覆盖。请从包自身的导出推导该集合，并断言受审名称集合等于导出名称集合，这样新组件或新图标一交付即被审计。

### 可能出什么问题

- **颜色对比度被报告为 undecided（未判定）**——jsdom 不计算布局，因此对比度检查什么也判定不了，且不计入分数的任何一侧。对比度回归需要浏览器通道来发现。
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
| [`src/index.ts`](src/index.ts) | `CLIENT_AXE_TAGS`、`auditSurface`、`accessibilityScore`、`formatViolations` |
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

- **jsdom 判定不了颜色对比度**——这些检查返回 incomplete 并被排除在分数之外。对比度应由浏览器通道来证明。
- **一次只审计一个 surface（受审面）**——该模块审计调用方已渲染好的 DOM 子树。它不挂载任何东西，也不了解 slot，因此由套件决定什么算一个 surface 以及如何构建它。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
