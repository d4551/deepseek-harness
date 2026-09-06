# Agent Note: UI SSOT 点击目标下限覆盖手写 `cursor: pointer` 控件

Status: implemented

[English](2026-09-06-ui-ssot-pointer-hit-target.md) | 中文

## Problem

[`scanUiSsot`](../../../../scripts/client-ui-ssot.ts) 只对 `button`、`[role=button]`、`.button` 与 `.iconButton` 强制 WCAG 2.5.8 的 24px 几何。以其他类名绘制并设置 `cursor: pointer` 的紧凑控件——字号步进箭头、附件轨删除、轨迹工具条芯片、JSON 树展开与复制——低于 24px，而现场语料仍为空。

## Decision

一条 CSS 规则在选择器属于上述按钮名**或**声明体设置 `cursor: pointer` 时，视为手写指针目标。该规则上任何低于 24px 的 `(min-)width` / `(min-)height` 都是 `hit-target` 发现。用户代理伪元素（`::`）、原生 `input` / `textarea` / `select`，以及 `pointer-events: none`，不是手写紧凑按钮（原生复选框、`::-webkit-search-cancel-button`、由父级轨道接管指针的仅键盘刻度）。注入的未命名 `.chip { cursor: pointer; width: 16px }` 失败；现场 client/web 语料不含这类发现。24px 产品规则仍在 [`docs/web-styling.md`](../../../../docs/web-styling.zh.md)。axe-core 仍通过[客户端无障碍通道](2026-08-29-client-accessibility-lane.zh.md)在已挂载 DOM 上持有运行时 WCAG 2.5.8；本收集器持有声明的 CSS 几何。

## Alternatives considered

**保留具名选择器允许列表。** 否决：这正是 17×12 步进箭头与 18×18 删除芯片能通过、而扫描只能看见 24px 的 `.iconButton` 的原因。

**标记每一条带有低于 24px 宽或高的规则。** 否决：字形、轨道与标题度量不是指针目标。

**在收集器中实现 WCAG 2.5.8 间距例外。** 否决：下限是目标规则上声明的 CSS 几何，与具名按钮情形相同。间距会让两个重叠的过小点击区通过。

## Consequences

提高或降低 24px 下限，须同时改 `HIT_TARGET_MIN_PX` 与 web-styling 句。新的紧凑控件必须在使它成为指针目标的同一条规则上声明至少 24px。拆分规则（`cursor` 在 `.root`，`width` 在 `.sidebar`）仍须把尺寸写在匹配的指针目标规则上；该拆分仍是具名覆盖缺口。
