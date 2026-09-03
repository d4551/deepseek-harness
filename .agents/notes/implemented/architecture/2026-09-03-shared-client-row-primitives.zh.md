# Agent Note: 共享的 Client 行原语

Status: implemented

[English](2026-09-03-shared-client-row-primitives.md) | 中文

## Problem

有十个 UI 组件各被重写了不止一次，散布在十一个 Client 包和一个扩展中。

这些副本是逐字相同的。圆形透明图标按钮出现了四次，分布在 `ui-sidebar`、`ui-workspace`、`ui-chat`、`ui-message-feedback`、`ui-goal` 与 `extensions/ui-cordis`。检视胶囊出现四次，元信息分隔点七次，行摘要五次。其中两处在自己的注释里写明了这一点：`packages/client/ui-tool/src/client/tool/toolviews/bash-sample.module.css` 记录了迁移到 `DisclosureRow` 会把它们合并为一个，而 `packages/client/ui-message-feedback/src/client/MessageFeedbackActions.module.css` 记录了它的动作按钮复制自 `ui-chat`。

没有任何检查因此失败。`bun run duplication` 读取的是 TypeScript 而非 CSS，而任何单文件规则都看不到由另一个包声明的规则体。这些副本按副本惯有的方式漂移：同一个胶囊带着两种不同的 `prefers-reduced-motion` 写法，同一个摘要带着两种不同的错误着色钩子。

## Decision

六个原语拥有此前被复制的内容：`FlowRow`、`RowSeparator`、`RowSummary`、`InspectPill`、`ResultText` 与 `GlyphButton`，全部位于 [`packages/client/ui-primitives`](../../../../packages/client/ui-primitives/README.zh.md)，并从该包已发布的入口导出。

`GlyphButton` 是一个带 `surface` 变体的组件，而不是四个组件。四个调用点都是同一个圆形透明图标按钮；它们之间盒模型与着色的差异是设计尚未统一的漂移，而此处的约束是像素级一致，因此基础规则只保留四者共有的部分，各变体各自补上自己的几何。把它们拆成四个原语只会在保留漂移的同时宣称那是有意为之。

调用点之间可用属性表达的差异被移入属性——摘要的错误着色改为 `tone` 属性，而非两个私有 CSS 钩子——确有差异的则留在原处。`CordisPanel` 的 hover 带 `:not(:disabled)` 守卫而 `GoalBar` 没有，因此两条 hover 规则都留给各自的拥有者。

有两条规则需要提升优先级而非搬移。`prefers-reduced-motion` 下的 `transition: none` 在 `SkillRow` 与 `CordisDefineRow` 中位于 (0,1,0)，在原语迁入另一个包的样式表之后，恰好与原语的 `transition` 打平，会把胜负交给打包顺序决定。两者都改为 `.card .inspectButton`，即 (0,2,0)。

防止其重新长回的是 [`scripts/client-ui-ssot.ts`](../../../../scripts/client-ui-ssot.ts)。凡是达到 `DUPLICATE_RULE_DECLARATIONS`（六条）声明及以上、且出现在两个 `.module.css` 中的规则体，都会被报告为 `duplicated-rule`。六是量出来的，而不是为方便而选：在本语料上，所有少于六条声明的重复规则体都是两个无关组件各自独立得出的通用惯用法——带单个 gap 的 flex 列、省略号截断、由颜色与字号与行高构成的文本层级——而六条及以上的每一个都是被写了两遍的同一个具名组件。省略号截断分别以三条、四条和五条声明出现，因此没有更低的阈值能把复制与趋同区分开。更窄的 `duplicated-shell` 带保持在三条声明，覆盖带有子元素间距的 grid 行，因此六条下限放过的小情形在要紧之处仍被覆盖。

## Alternatives considered

**共享 CSS 而非组件。** 在本流水线中 `composes: … from` 会被编译成空类，`packages/client/ui-tool/src/client/tool/toolviews/bash-sample.tsx:20` 已经记录了这一点，且 `.module.css` 没有包级导出入口。共享 React 组件是唯一存在的通道。

**采用全局主题类，如 `visually-hidden.css` 与 `z-scale.css` 那样。** 对单一属性的工具类是对的；对带有结构、状态属性和 SVG 子元素的控件则不对——那是组件，属于组件包。

**把 `BashRow` 迁移到既有的 `DisclosureRow` 上。** 它自己的注释正是这样提议的，而且会再消除一份副本。但它同时会丢掉 `data-sample`、`data-variant` 与 `data-state`，把视觉隐藏的状态 span 移到标题之后，并给卡片加上 `width: 100%; min-width: 0`——这是 DOM 与视觉上的改变，而此处的约束是每个调用点渲染结果一致。`FlowRow` 消除了重复的规则体，并让两处 DOM 保持逐字节相同。

**提高阈值直到语料通过。** 这正是该检测器要防止的做法，而上述测量正是使六这个值站得住脚、而非仅仅方便的理由。

## Consequences

一个控件现在只有一个拥有者，因此对图标按钮的修改会到达使用它的每个界面，而不是六处中的一处。代价是想要有所不同的调用点必须以属性写明，而覆盖规则位于另一个包样式表中的调用点则必须考虑优先级——已经有两条规则需要如此。

这次提取暴露了被副本掩盖的死代码：`HeroShell.module.css` 携带着一段模态输入框、动作与错误的规则块，而它唯一的导入方 `EmptyHero.tsx` 从未引用过它们。该块已被删除。

有一个名字在测试压力下改变了。该原语原名 `IconButton`，直到 `packages/client/ui-primitives/tests/icons.client.spec.tsx` 把它当作图标来审计——因为该套件按仓库的 `Icon*` 约定筛选导出。`GlyphButton` 说明了它是什么，同时不声称自己是图标。
