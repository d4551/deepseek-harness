# Agent Note: TSX 内联颜色门禁与插图标 token 化

Status: implemented

[English](2026-09-01-tsx-inline-color-gate.md) | 中文

## 问题

`.bao`/web 样式 SSOT 规则禁止产品 UI 中的字面颜色，`client-ui-ssot` 也在执行——但它的 `token-bypass` 检测器只读 `.css`，于是每个 TSX `style={{ ... }}` prop 与 SVG `fill`/`stroke` 属性都成了不受管的旁路通道。剩余违规恰好都在那里：`katex.tsx` 把 KaTeX 错误红写成内联，两幅拖放遮罩插图和一处主视觉光晕用原始十六进制属性上色——它们无法参与主题切换。

## 决策

`scripts/client-ui-ssot.ts` 新增 `tsx-inline-color` 检测器：TSX 样式对象中的字面颜色（`color: 'rgb(204, 0, 0)'`、`fill: rgb(...)`）与 SVG 表现属性中的字面颜色（`fill="rgb(57, 100, 254)"`）在主题目录之外即令扫描失败。

线上违规被修复而非豁免：

- `ui-primitives/src/markdown/katex.tsx` —— 错误 span 的字面红移入 `MarkdownText.module.css` 的 `.katex-error { color: var(--dsw-static-red-500) }`（该文件的类本就为 `.katex-display` 全局化）。
- `ui-attachment/src/DropOverlay.tsx` —— 两幅 SVG 插图改由 `DropOverlay.module.css` 的类取色；调色板新增静态插图色带（两个 `design-platform.css` 主题块中的 `--dsw-static-illustration-{hero,teal,blue,card,amber}`），复用既有 token（主蓝 `rgb(103, 158, 254)`→`deepseek-400`，插图蓝 `rgb(57, 100, 254)`→`blue-600`，中性灰 `rgb(151, 157, 166)`→`neutral-bluish-500`）。
- `ui-conversation/src/client/skeleton/EmptyHero.tsx` —— 主视觉光晕椭圆的字面长春花色改为 `ConversationRoot.module.css` 中的 `heroCss.heroGlowEllipse`（`--dsw-static-illustration-hero`），紧邻消费该组件的 `.heroGlow` 定位类。

检测器证明在 `scripts/client-ui-ssot.spec.ts`：每种被认定的形式（样式对象字面量、SVG 颜色属性）各一例，另有反例（className 样式、`currentColor`、`left` 这类非颜色几何）。

该检测器是对 TSX 文本的正则而非 AST。动态取值（`fill={x}`）与 TSX 里经 `setProperty` 设置的 CSS 自定义属性不在其内——后者由 `--ds[wh]-` 声明索引覆盖——样式对象中的时序/几何字面量（`transition: 'transform 120ms ease'`）需要带自身形式证明的独立检测器。

## 备选方案

**扩展 `token-bypass` 读 TSX。** 两种 finding kind 回答的问题不同——CSS 绘制属性上的字面量与 TSX 对象成员/JSX 属性——合并会模糊适用哪条规则、哪种修法。独立 kind 让门禁信息可执行。

**改为把 SVG 标准化进资产管线。** 插图是为布局耦合服务的内联 JSX，不是独立资产；管线会把它们移出按尺寸约束它们的组件。CSS Module 类让它们留在原地、调色板掌管颜色。

**把 `currentColor` 一类约定留给评审。** CSS Modules 语料已有门禁；审计显示剩余通道恰是未被门禁的那一个。止步于 `.css` 边界的规则，下一幅插图就能绕过。

## 后果

TSX 不再绕过颜色 SSOT，插图 SVG 也能像十六进制属性做不到的那样参与明暗主题切换。代价是正则形态的检测器：它读文本不读语法，真正的动态颜色表达式对它不可见——AST 级检查能抓更多，但要在 CI 里引入 TSX 解析器依赖。
