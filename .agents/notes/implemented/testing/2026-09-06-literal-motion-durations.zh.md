# Agent Note: 动效时长采用可折叠的 token

Status: implemented

[English](2026-09-06-literal-motion-durations.md) | 中文

## Problem

[`base.css`](../../../../packages/client/ui-theme/src/styles/base.css) 在 `prefers-reduced-motion: reduce` 下把 `--ds-transition-duration`、`-fast` 与 `-slow` 折叠为 `0.01ms`。这就是全部机制：以任何其他方式写出的时长，都是该设置无法触及的动效。

客户端中只有三条声明使用了该 token，另外四十五条没有——三十个样式表里写着 `120ms`、`.16s`、`220ms`、`0.4s`，还有一处 `1000ms` 的 toast 淡出，外加一处写在 TSX 样式对象里的 `transition: 'transform 120ms ease'`，那里任何媒体查询都完全够不着。[`docs/web-styling.md`](../../../../docs/web-styling.zh.md) 要求新增过渡时具备 reduced-motion 行为；却没有任何东西对此进行测量。

原有的 `reduced-motion` 检测器只回应带 `infinite` 的 `animation` 声明。所有 `transition` 以及所有有限次数的 `animation` 都在其范围之外。

## Decision

客户端 CSS 中的 `transition` 或 `animation` 要么通过 `--ds-transition-duration*` 声明时长，要么在 `prefers-reduced-motion` 块中按名字被回应。检测器逐层读取取值中以逗号分隔的每一层，因为缓动函数自身带有逗号，`cubic-bezier(0.2, 0.8, 0.2, 1)` 是一层而非四层。每层内只看第一个时间值：时长在延迟之前，因此一个把保持时间写作 `var(--dsh-toast-hold, 3000ms)` 的 toast，即便后面出现字面量，其时长仍是通过 token 声明的。

无限动画仍归原有规则报告，这样一个选择器不会被读成两个问题。`stopsTransition` 扩展了 `stopsAnimation` 已有的守卫词汇：`transition: none`，或声明的时长不超过一毫秒；并且每个声明的时间都必须这么短——只缩短一个属性而让另一个继续运动的守卫，并没有停止动效。

TSX 样式对象单独检查，而不是把 TSX 当作 CSS 解析。它不携带媒体查询，因此其中的字面量时长在任何情况下都无法被守卫；修复方式是改用 CSS Module 类，模型列表的折叠箭头现在正是如此。

这四十五条声明被映射到既有的三档刻度上：不超过 120ms 归 `-fast`，不超过 250ms 归基础 token，更长的归 `-slow`。两处写明 `150ms` 的侧边栏断言属于过时行为，已随样式表一并修改。

## Alternatives considered

**只标记 transform 与位置类过渡。** 否决：主题会折叠该刻度上的每一个时长，因此保留字面量的颜色淡入淡出与主题已确立的机制不一致，而且这种区分需要一份无人维护的按属性清单。

**要求每个文件写 `prefers-reduced-motion` 块，而非使用 token。** 否决：这会在三十个样式表中重复一条主题规则已经做到的事，而按文件写的守卫会与它本应回应的规则发生漂移。

**保留字面量时长，改用 `*` 扩大主题折叠范围。** 否决：`@media (prefers-reduced-motion: reduce) { * { transition: none } }` 会整体覆盖组件意图，包括组件有意保留的过渡，而且它同样够不着 TSX 样式对象。

## Consequences

字面量不落在刻度上的地方，时序略有变化：`140ms` 与 `180ms` 现在按 `0.2s` 运行，`0.4s` 按 `0.3s` 运行。需要刻度之外时长的组件应向主题新增第四个 token，而不是写字面量，这样折叠仍能触及它。扫描无法读作时长的动效取值——例如时间来自另一个自定义属性的情形——会被接受，因此该检查陈述的是它能证明无法触及的动效，而非所有此类情形。
