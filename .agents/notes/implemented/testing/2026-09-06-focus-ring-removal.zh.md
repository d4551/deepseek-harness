# Agent Note: 移除焦点环必须提供替代

Status: implemented

[English](2026-09-06-focus-ring-removal.md) | 中文

## Problem

[`base.css`](../../../../packages/client/ui-theme/src/styles/base.css) 按元素和按 role 提供键盘焦点环，其自身注释也写明组件的 `:focus-visible` 会在优先级上胜过它。有六条组件规则关闭了该焦点环。其中五条提供了替代——内层元素的 outline、伪元素覆盖层、图标颜色——而 `TrajectoryTable.module.css` 中的 `.detailsResizeHandle:focus-visible` 是一条裸的 `outline: none`，让键盘用户在拖拽把手上完全没有指示。没有任何东西测量这一差别。

另外，插件设置字段中的 `.input:focus-visible` 把 1px 的 `border-color` 变化当作全部焦点指示；`TeamAction` 把焦点移入 `role="dialog"` 面板却没有 `Escape` 处理，而两个兄弟操作（`JobListAction`、`WorkspaceRootsAction`）都有。

## Decision

一条 `:focus-visible` 规则若整个规则体只是关闭焦点环，即为一处问题，除非同一样式表中另有规则命名了同一个带焦点的选择器。这是该问题中客观的一半：画在内层元素上（`.b:focus-visible .wrap`）或通过伪元素（`.row:has(> .e:focus-visible)::after`）的替代都会提及该选择器，而无关的规则不会。替代的颜色是否*足够*作为指示是扫描不做的判断，因此它只报告完全没有替代的情形。

这三处缺陷是修复而非豁免：拖拽把手采用主题焦点环的内嵌形式；设置输入框保留品牌色边框并把焦点环加回来；`TeamAction` 通过它本就有的 `closePanel` 在 `Escape` 时关闭。

## Alternatives considered

**报告每一处仅以颜色替代的 `:focus-visible`。** 否决：`.sourceBlockJumpTarget` 改变图标颜色，`.requestBoundaryControl` 改变伪元素颜色，两者都是有意为之。是否足够需要针对解析后的主题做对比度测量，而样式表扫描做不到；靠猜的规则会对正常工作的指示误报。

**直接禁止 `:focus-visible` 下出现 `outline: none`。** 否决：内嵌式或覆盖式焦点环正当地以清除用户代理默认环开始，六条规则中有五条正是如此。

**给 `TeamAction` 加焦点陷阱。** 否决：兄弟操作以 `Escape` 关闭并允许 Tab 离开，同一个头部里三个浮层行为不一致才是缺陷。与它们保持一致才是修复。

## Consequences

清除焦点环的组件现在必须在样式表能看到的地方画一个。若替代画在另一个样式表中——由父级包的样式表伸进来——会被读作没有替代，这与 CSS Modules 已经对本扫描其余部分施加的文件局部限制是同一种。
