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

根测试运行器和浏览器运行器要求每个选中的源码审计候选提供执行证据。每个必需测试必须通过，并以 100 分验证自身的原生 axe 结果。跳过的测试、不可达的检查、未注册的定义、自行构造的结果对象，以及从其他测试借用的结果，都不能满足该要求。运行 `bunx vitest run --config vitest.client-browser.config.ts` 可检查完整的包级候选清单；定向运行会明确报告证据不完整。

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

该模块固定 `axe.run` 的标签清单，请求 violations、passes 与 incomplete 结果，并把 axe 的按规则节点数组转换为计数。原始 incomplete 结果和计数保持完整，不计入分数。对于 axe 的确切 `controlsWithinPopup` 审查，`completedReviews` 记录原生 DOM 证据：每个受控 ID 唯一解析，弹窗角色匹配 `aria-haspopup`，展开的弹窗可见且可访问。其他未判定检查，以及缺少上述证据的弹窗审查，都会使 `accessibilityFailures` 失败。

审计引擎保留原生结果的对象身份与不可变的原始失败报告，随后发布执行与成功验证事件。修改返回结果不能抹去原生失败。浏览器初始化将两类事件绑定到 Vitest 的实际测试任务。报告器检查完整配置的发现范围是否包含源码候选，按定义位置（包括列号）核对执行凭据；必需测试缺少通过凭据时，检查失败。通过 CLI 或 Vitest 公共 API 显式选择文件时，报告会标明证据不完整。静态源码检查发现审计义务；只有完成的浏览器工作才能提供执行证据。

### 源码地图

| 文件 | 作用 |
|---|---|
| [`src/index.ts`](src/index.ts) | `CLIENT_AXE_TAGS`、`clientAxeRunOptions`、`auditSurface`、`accessibilityFailures`、`accessibilityScore`、`formatViolations` |
| [`src/popup-review.ts`](src/popup-review.ts) | 弹窗引用审查的原生 DOM 验证 |
| [`src/execution.ts`](src/execution.ts) | 原生结果身份与执行观察器 |
| [`tests/browser-setup.client.ts`](tests/browser-setup.client.ts) | 原生测试任务归属与产品主题初始化 |
| [`../../../scripts/client-a11y-reporter.ts`](../../../scripts/client-a11y-reporter.ts) | 必需测试执行核对 |
| [`src/invariant.ts`](src/invariant.ts) | 包不变式伴生插件注册 |

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
- **候选发现有语法边界**——包归属通过源码导入、渲染与断言检查确定。测试归属分析跟踪 Vitest 具名导入，以及直接调用、本地函数或具名相对路径辅助函数调用。命名空间导入、再导出链与生成测试的工厂仍需进一步源码分析；该清单并不能证明组件、状态或用户流程已被完整覆盖。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文 — 点击展开</summary>

无。

</details>
